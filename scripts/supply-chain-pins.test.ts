import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// Guards the OpenSSF Scorecard TokenPermissions and PinnedDependencies checks:
// write scopes are granted per job, never at the workflow top level, and every
// third-party action and base image is pinned to an immutable digest.

const workflowDir = new URL("../.github/workflows/", import.meta.url);
const workflowFiles = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));

type Permissions = string | Record<string, string> | undefined;

type Workflow = {
  permissions?: Permissions;
  jobs?: Record<string, { steps?: Array<{ uses?: string }> }>;
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
    test(`${name} pins every action to a full commit SHA`, () => {
      const unpinned = Object.values(loadWorkflow(name).jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .map((step) => step.uses)
        .filter((uses): uses is string => typeof uses === "string" && !uses.startsWith("./"))
        .filter((uses) => !/@[0-9a-f]{40}$/.test(uses));
      expect(unpinned).toEqual([]);
    });
  }
});

describe("Dockerfile base images", () => {
  test("pins every external base image by digest", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const stages = new Set<string>();
    const unpinned: string[] = [];
    for (const match of dockerfile.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/gim)) {
      const image = match[1]!;
      if (!stages.has(image) && !/@sha256:[0-9a-f]{64}$/.test(image)) unpinned.push(image);
      if (match[2]) stages.add(match[2]);
    }
    expect(unpinned).toEqual([]);
  });
});
