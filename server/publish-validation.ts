import { parse } from "smol-toml";
import type { ServerConfig } from "./config";
import { RequestError } from "./http";
import type { PublishRegistryEntry, PublishRequestRow } from "./types";

type PackToml = {
  pack?: {
    name?: unknown;
  };
};

type FetchTextFn = (input: string, init?: RequestInit) => Promise<Response>;

type PublishValidationOptions = {
  fetchFn?: FetchTextFn;
  computeHash?: (request: PublishRequestRow) => Promise<string>;
  gcBin?: string;
  timeoutMs?: number;
};

const hashPattern = /^sha256:[0-9a-f]{64}$/;
const maxPackTomlBytes = 256 * 1024;
const maxReadmeBytes = 512 * 1024;

export async function validatePublishRequestForRegistry(
  request: PublishRequestRow,
  config: ServerConfig,
  options: PublishValidationOptions = {},
): Promise<PublishRegistryEntry> {
  const fetchFn = options.fetchFn ?? fetch;
  const packToml = await fetchTextLimited(packTomlUrl(request), maxPackTomlBytes, fetchFn);
  const actualPackName = packNameFromToml(packToml, request.packPath);
  if (actualPackName !== request.requestedName) {
    throw new RequestError(
      422,
      "PACK_NAME_MISMATCH",
      `pack.toml declares ${JSON.stringify(actualPackName)}, not ${JSON.stringify(request.requestedName)}.`,
    );
  }

  const readme = await fetchReadme(request, fetchFn);
  const description =
    request.requestedDescription ??
    descriptionFromReadme(readme) ??
    `${request.requestedName} pack from ${request.repository.fullName}.`;
  const hash = options.computeHash
    ? await options.computeHash(request)
    : await computePackHash(request, {
        gcBin: options.gcBin ?? config.publishValidation.gcBin,
        timeoutMs: options.timeoutMs ?? config.publishValidation.timeoutMs,
      });
  if (!hashPattern.test(hash)) {
    throw new RequestError(502, "BAD_GC_HASH", "gc returned an invalid pack content hash.");
  }

  return {
    name: request.requestedName,
    description,
    source: request.sourceUrl,
    sourceKind: "git",
    release: {
      version: request.requestedVersion,
      ref: request.requestedRef ?? request.commit,
      commit: request.commit,
      hash,
      description: request.requestedDescription ?? `Publish ${request.requestedName} ${request.requestedVersion}.`,
    },
  };
}

export async function computePackHash(
  request: Pick<PublishRequestRow, "repoUrl" | "commit" | "packPath">,
  options: { gcBin: string; timeoutMs: number },
) {
  const args = ["pack", "release", "hash", request.repoUrl, "--commit", request.commit];
  if (request.packPath !== ".") args.push("--path", request.packPath);
  const proc = Bun.spawn([options.gcBin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: sanitizedGcEnv(),
  });
  const timeout = setTimeout(() => {
    proc.kill();
  }, options.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new RequestError(
        422,
        "PACK_HASH_FAILED",
        scrubGcError(stderr || stdout || "gc pack release hash failed."),
      );
    }
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizedGcEnv() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || gitEnvBlacklist.has(key)) continue;
    env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

const gitEnvBlacklist = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_EXEC_PATH",
  "GIT_PAGER",
]);

async function fetchReadme(request: PublishRequestRow, fetchFn: FetchTextFn) {
  for (const name of ["README.md", "README.mdx", "readme.md", "SKILL.md"]) {
    try {
      return await fetchTextLimited(rawGitHubUrl(request, name), maxReadmeBytes, fetchFn);
    } catch {
      // Try the next conventional README path.
    }
  }
  return undefined;
}

async function fetchTextLimited(url: string, maxBytes: number, fetchFn: FetchTextFn) {
  const response = await fetchFn(url, {
    headers: { Accept: "text/plain, text/markdown" },
  });
  if (!response.ok) {
    throw new RequestError(422, "UPSTREAM_FETCH_FAILED", `Unable to fetch ${new URL(url).pathname}.`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    throw new RequestError(422, "UPSTREAM_FILE_TOO_LARGE", "Upstream metadata file is too large.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new RequestError(422, "UPSTREAM_FILE_TOO_LARGE", "Upstream metadata file is too large.");
  }
  return text;
}

function packNameFromToml(text: string, packPath: string) {
  let raw: PackToml;
  try {
    raw = parse(text) as PackToml;
  } catch {
    throw new RequestError(422, "PACK_TOML_INVALID", `${displayPackPath(packPath)}/pack.toml is not valid TOML.`);
  }
  const name = typeof raw.pack?.name === "string" ? raw.pack.name.trim() : "";
  if (!name) {
    throw new RequestError(422, "PACK_NAME_MISSING", `${displayPackPath(packPath)}/pack.toml is missing [pack].name.`);
  }
  return name;
}

function descriptionFromReadme(text: string | undefined) {
  if (!text) return undefined;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = lines.find((line) => line.startsWith("# "))?.replace(/^#+\s*/, "").trim();
  const paragraph = lines.find((line) => !line.startsWith("#") && !line.startsWith("```"));
  const description = paragraph ?? heading;
  return description ? description.replace(/\s+/g, " ").slice(0, 240) : undefined;
}

function packTomlUrl(request: PublishRequestRow) {
  return rawGitHubUrl(request, "pack.toml");
}

function rawGitHubUrl(request: PublishRequestRow, fileName: string) {
  const parts = [request.repository.owner, request.repository.name, request.commit];
  if (request.packPath !== ".") parts.push(...request.packPath.split("/"));
  parts.push(fileName);
  return `https://raw.githubusercontent.com/${parts.map(encodeURIComponent).join("/")}`;
}

function displayPackPath(packPath: string) {
  return packPath === "." ? "." : packPath;
}

function scrubGcError(value: string) {
  return value
    .replace(/https:\/\/[^@\s]+@github\.com/g, "https://github.com")
    .trim()
    .slice(0, 500);
}
