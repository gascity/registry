import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// Guards the OpenSSF Scorecard TokenPermissions and PinnedDependencies checks:
// write scopes are granted per job, never at the workflow top level, and every
// third-party action, reusable workflow and base image is pinned to an
// immutable digest.

const workflowDir = new URL("../.github/workflows/", import.meta.url);
const workflowFiles = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));

type Permissions = string | Record<string, string> | undefined;

type Workflow = {
  permissions?: Permissions;
  jobs?: Record<string, { uses?: string; steps?: Array<{ uses?: string }> }>;
};

function loadWorkflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(new URL(name, workflowDir), "utf8")) as Workflow;
}

function writeScopes(permissions: Permissions): string[] {
  if (permissions === undefined) return ["<unset: defaults to the repo token policy>"];
  if (typeof permissions === "string") return permissions === "read-all" ? [] : [permissions];
  return Object.entries(permissions)
    .filter(([, level]) => level === "write")
    .map(([scope]) => scope);
}

// A full commit SHA for actions and reusable workflows; a content digest for
// docker:// actions.
function isPinned(uses: string): boolean {
  return uses.startsWith("docker://")
    ? /@sha256:[0-9a-f]{64}$/.test(uses)
    : /@[0-9a-f]{40}$/.test(uses);
}

function unpinnedActions(workflow: Workflow): string[] {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => [job.uses, ...(job.steps ?? []).map((step) => step.uses)])
    .filter((uses): uses is string => typeof uses === "string" && !uses.startsWith("./"))
    .filter((uses) => !isPinned(uses));
}

// `scratch` and earlier stage names (both case-insensitive) pull nothing, so
// they need no digest.
function unpinnedBaseImages(dockerfile: string): string[] {
  const local = new Set(["scratch"]);
  const unpinned: string[] = [];
  for (const match of dockerfile.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/gim)) {
    const image = match[1]!;
    if (!local.has(image.toLowerCase()) && !/@sha256:[0-9a-f]{64}$/.test(image)) {
      unpinned.push(image);
    }
    if (match[2]) local.add(match[2].toLowerCase());
  }
  return unpinned;
}

describe("workflow token permissions", () => {
  test("finds the workflows", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  for (const name of workflowFiles) {
    test(`${name} grants no write scope at the top level`, () => {
      expect(writeScopes(loadWorkflow(name).permissions)).toEqual([]);
    });
  }
});

describe("workflow action pins", () => {
  for (const name of workflowFiles) {
    test(`${name} pins every action and reusable workflow`, () => {
      expect(unpinnedActions(loadWorkflow(name))).toEqual([]);
    });
  }
});

describe("Dockerfile base images", () => {
  test("pins every external base image by digest", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    expect(unpinnedBaseImages(dockerfile)).toEqual([]);
  });
});

describe("pin detection", () => {
  const sha = "a".repeat(40);
  const digest = `sha256:${"b".repeat(64)}`;

  test("counts only write levels as top-level write scopes", () => {
    expect(writeScopes("read-all")).toEqual([]);
    expect(writeScopes({})).toEqual([]);
    expect(writeScopes({ contents: "read", "id-token": "write" })).toEqual(["id-token"]);
    expect(writeScopes("write-all")).toEqual(["write-all"]);
    expect(writeScopes(undefined)).toHaveLength(1);
  });

  test("flags tag-pinned actions and reusable workflows, not SHA-pinned or local ones", () => {
    const workflow: Workflow = {
      jobs: {
        build: {
          steps: [
            { uses: "actions/checkout@v4" },
            { uses: `actions/checkout@${sha}` },
            { uses: "./.github/actions/local" },
            { uses: "docker://alpine:3.20" },
            { uses: `docker://alpine@${digest}` },
          ],
        },
        shared: { uses: "example/workflows/.github/workflows/ci.yml@main" },
        pinned: { uses: `example/workflows/.github/workflows/ci.yml@${sha}` },
        local: { uses: "./.github/workflows/local.yml" },
      },
    };
    expect(unpinnedActions(workflow)).toEqual([
      "actions/checkout@v4",
      "docker://alpine:3.20",
      "example/workflows/.github/workflows/ci.yml@main",
    ]);
  });

  test("flags undigested base images, not stage references or scratch", () => {
    const dockerfile = [
      `FROM golang:1.26-alpine@${digest} AS Builder`,
      "FROM --platform=$BUILDPLATFORM oven/bun:1 AS web",
      "from builder",
      "FROM scratch",
      "FROM web",
    ].join("\n");
    expect(unpinnedBaseImages(dockerfile)).toEqual(["oven/bun:1"]);
  });
});
