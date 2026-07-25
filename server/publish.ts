import { posix as path } from "node:path";
import type {
  GitHubRepositoryRef,
  NormalizedPublishRequestInput,
  PackNameClaim,
  PublishRequestInput,
  PublishRequestRow,
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

// The name split into URL path segments, and the SPA pack route built from them. Deliberately a
// duplicate of src/lib/packName.ts + src/lib/urlState.ts's packPath: tsconfig.app.json includes
// only `src` and tsconfig.server.json only `server`, both composite, so a cross-project import
// fails typecheck and would leak the app project's DOM lib into the server project. The two copies
// are pinned together by identical expectation tables in server/publish.test.ts and
// src/lib/urlState.test.ts. Drift is bounded: the SPA accepts both URL forms and canonicalizes in
// place, so the worst case is landing on the non-canonical URL for one replaceState.
export function packNameSegments(name: string) {
  return name.split("/");
}

// One real path segment per name segment. A `%2F` would not survive the apex `/registry/*` prefix
// strip — rewriting the decoded path without keeping the raw path in sync turns the escape back
// into a separator — and the pre-slice-5 SPA read the resulting `/packs/owner/pack` as home.
export function packRoutePath(name: string) {
  return `/packs/${packNameSegments(name).map(encodeURIComponent).join("/")}`;
}

// Does an incoming publish come from the repo a name claim is pinned to? Compares GitHub's
// numeric repository id when BOTH sides know it (rename-stable), and otherwise falls back to the
// case-folded repo full name — claim-only publishes and grandfathered claims prove no ids. The
// owner login is checked too: a repo TRANSFER keeps its id while moving to a different account,
// and that account must not inherit the name.
//
// Lives here rather than in app.ts because BOTH layers need the identical rule: the merge gate
// reads the claim and refuses a mismatch, and approvePublishRequest re-checks it inside the
// approve transaction (the gate's read is not serialized against a concurrent approval of the
// same name). One Source of Truth — two copies of this predicate could admit a publish the gate
// refused, or the reverse.
export function nameClaimMatchesRequest(claim: PackNameClaim, request: PublishRequestRow) {
  // Owner identity by numeric id when both sides know it, because that is what survives an account
  // RENAME — comparing logins alone would 409 a publisher who simply renamed their GitHub account
  // and force a staff re-pin. A TRANSFER still fails here, which is the point: it changes the owner
  // id. Falls back to the login when either side proved no owner id (claim-only, grandfathered).
  if (claim.githubOwnerId && request.sourceGithubOwnerId) {
    if (claim.githubOwnerId !== request.sourceGithubOwnerId) return false;
  } else if (claim.githubOwnerLogin.toLowerCase() !== request.repository.owner.toLowerCase()) {
    return false;
  }
  if (claim.githubRepositoryId && request.sourceGithubRepositoryId) {
    return claim.githubRepositoryId === request.sourceGithubRepositoryId;
  }
  return claim.repoFullName.toLowerCase() === request.repository.fullName.toLowerCase();
}

// Same rule as above, between two publish requests: the lineage filter on the withdrawn-version
// guard. Ids first when both are stamped, else the case-folded repo full name.
export function sameSourceRepository(left: PublishRequestRow, right: PublishRequestRow) {
  if (left.sourceGithubRepositoryId && right.sourceGithubRepositoryId) {
    return left.sourceGithubRepositoryId === right.sourceGithubRepositoryId;
  }
  return left.repository.fullName.toLowerCase() === right.repository.fullName.toLowerCase();
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
