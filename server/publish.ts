import { posix as path } from "node:path";
import type {
  GitHubRepositoryRef,
  NormalizedPublishRequestInput,
  PublishRequestInput,
} from "./types";

// Bare or single-scoped, each segment starting alphanumeric. Ingest uses the bare-only half of
// this grammar (scripts/generate-registry.lib.ts) — the two are deliberately different and
// deliberately not shared, since `scripts/` and `server/` have no import coupling.
const packNamePattern = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/;
// Mirrors ValidatePackName in internal/packregistry/catalog.go. `gc` rejects a segment over 64
// characters and ValidateCatalog aborts on the FIRST bad name, so a single over-long approved
// name would hide the whole catalog — all 15 first-party packs included — from every client.
const maxPackNameSegment = 64;
const releaseVersionPattern = /^[0-9]+\.[0-9]+(\.[0-9]+)?$/;
const commitPattern = /^[0-9a-f]{40}$/;
const safePathPattern = /^[A-Za-z0-9._/@+-]+$/;
const safeRefPattern = /^[A-Za-z0-9._/@+-]+$/;

// The scope segment of a pack name (`acme` of `acme/tools`); undefined for a bare name. The
// grammar above allows at most one slash, so a name carries either exactly one scope or none —
// which is what partitions the namespace: bare names are reserved, scoped names belong to the
// GitHub owner they are named for.
export function packNameScope(name: string) {
  const [scope, rest] = name.split("/");
  return rest ? scope : undefined;
}

// `owner/pack` flattens to `owner--pack` for pack_key and og filenames, so the flattening must
// be injective or two names pool under one identity. Banning `--` inside a segment is what
// makes it injective: a legal flattened name contains a `--` only where a `/` was, and it can
// only be split there one way (any other split would put `--` inside a segment or start a
// segment with `-`, and both are rejected). Both anchors are load-bearing.
export function assertPublishablePackName(name: string) {
  // Length first: requestedName is otherwise unbounded (`requested_name text` in the store), so
  // this also keeps the pattern off a megabyte of dashes.
  for (const segment of name.split("/")) {
    if (segment.length > maxPackNameSegment) {
      throw new PublishRequestValidationError(
        `Pack name segments may be at most ${maxPackNameSegment} characters.`,
      );
    }
  }
  if (name.includes("--")) {
    throw new PublishRequestValidationError(
      "Pack name may not contain consecutive dashes; use single dashes between words.",
    );
  }
  if (!packNamePattern.test(name)) {
    throw new PublishRequestValidationError(
      "Pack name must be lowercase words separated by dashes, optionally scoped with one slash.",
    );
  }
}

export function isPublishablePackName(name: string) {
  try {
    assertPublishablePackName(name);
    return true;
  } catch {
    return false;
  }
}

export function normalizePublishRequestInput(
  input: PublishRequestInput,
): NormalizedPublishRequestInput {
  const repository = parseGitHubRepositoryUrl(input.repoUrl);
  const commit = stringField(input.commit, "commit").toLowerCase();
  if (!commitPattern.test(commit)) {
    throw new PublishRequestValidationError("Commit must be a full lowercase Git SHA.");
  }

  const requestedName = stringField(input.requestedName, "requestedName");
  assertPublishablePackName(requestedName);

  const requestedVersion = stringField(input.requestedVersion, "requestedVersion");
  if (!releaseVersionPattern.test(requestedVersion)) {
    throw new PublishRequestValidationError("Version must be semver major.minor[.patch].");
  }

  const packPath = normalizePackPath(input.packPath);
  const requestedRef = normalizeOptionalRef(input.requestedRef);
  const requestedDescription = normalizeOptionalDescription(input.requestedDescription);

  return {
    repoUrl: canonicalGitHubRepoUrl(repository),
    repository,
    sourceUrl: sourceUrlFor(repository, commit, packPath),
    packPath,
    commit,
    requestedName,
    requestedVersion,
    requestedRef,
    requestedDescription,
  };
}

export function parseGitHubRepositoryUrl(value: string): GitHubRepositoryRef {
  const trimmed = stringField(value, "repoUrl");
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return repositoryRef(sshMatch[1], sshMatch[2]);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PublishRequestValidationError("Repository URL must be a GitHub HTTPS or SSH URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new PublishRequestValidationError("Only github.com repositories are supported.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new PublishRequestValidationError("Repository URL must not include credentials, query, or fragment.");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new PublishRequestValidationError("Repository URL must point at a GitHub repository root.");
  }
  return repositoryRef(segments[0], segments[1].replace(/\.git$/i, ""));
}

export function normalizePackPath(value: string | undefined) {
  const trimmed = value?.trim() || ".";
  if (trimmed === ".") return ".";
  if (trimmed.length > 240) throw new PublishRequestValidationError("Pack path is too long.");
  if (trimmed.includes("\\") || trimmed.startsWith("/") || trimmed.includes("\0")) {
    throw new PublishRequestValidationError("Pack path must be a relative POSIX path.");
  }
  if (!safePathPattern.test(trimmed)) {
    throw new PublishRequestValidationError("Pack path contains unsupported characters.");
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new PublishRequestValidationError("Pack path must not contain empty, dot, or dot-dot segments.");
  }
  return path.normalize(trimmed);
}

function repositoryRef(owner: string, rawName: string): GitHubRepositoryRef {
  const name = rawName.replace(/\.git$/i, "");
  if (!isGitHubName(owner) || !isGitHubName(name)) {
    throw new PublishRequestValidationError("Repository owner and name must be valid GitHub names.");
  }
  return {
    host: "github.com",
    owner,
    name,
    fullName: `${owner}/${name}`,
  };
}

function isGitHubName(value: string) {
  return (
    value.length > 0 &&
    value.length <= 100 &&
    /^[A-Za-z0-9_.-]+$/.test(value) &&
    !value.startsWith(".") &&
    !value.endsWith(".")
  );
}

function canonicalGitHubRepoUrl(repository: GitHubRepositoryRef) {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(
    repository.name,
  )}`;
}

function sourceUrlFor(repository: GitHubRepositoryRef, commit: string, packPath: string) {
  const base = `${canonicalGitHubRepoUrl(repository)}/tree/${commit}`;
  if (packPath === ".") return base;
  return `${base}/${packPath.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizeOptionalRef(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 120) throw new PublishRequestValidationError("Requested ref is too long.");
  if (
    !safeRefPattern.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed.includes("@{") ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/")
  ) {
    throw new PublishRequestValidationError("Requested ref is not a safe Git ref label.");
  }
  return trimmed;
}

function normalizeOptionalDescription(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 500) {
    throw new PublishRequestValidationError("Requested description is too long.");
  }
  return trimmed;
}

function stringField(value: string | undefined, field: string) {
  const trimmed = value?.trim();
  if (!trimmed) throw new PublishRequestValidationError(`${field} is required.`);
  if (/[\0-\x1f\x7f]/.test(trimmed)) {
    throw new PublishRequestValidationError(`${field} contains control characters.`);
  }
  return trimmed;
}

export class PublishRequestValidationError extends Error {
  readonly status = 422;
  readonly code = "VALIDATION_ERROR";
}
