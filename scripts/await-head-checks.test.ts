import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  awaitHeadChecks,
  type CheckRun,
  evaluateChecks,
  nextPageUrl,
  parseArgs,
} from "./await-head-checks";

const SHA = "a41ccacccb7e2f1eaf8313906a26e227cdb750e2";
const REQUIRED = ["CI / required"];

const queued = (name: string): CheckRun => ({ name, status: "queued", conclusion: null });
const running = (name: string): CheckRun => ({ name, status: "in_progress", conclusion: null });
const done = (name: string, conclusion = "success"): CheckRun => ({
  name,
  status: "completed",
  conclusion,
});

describe("evaluateChecks", () => {
  test("no check runs yet is unregistered, not a failure", () => {
    expect(evaluateChecks([], REQUIRED)).toEqual({ state: "unregistered" });
  });

  test("waits for a required check that has not been registered yet", () => {
    // `CI / required` only appears once `verify` finishes; every check that does exist being
    // green in that gap must not count as success.
    expect(evaluateChecks([done("verify"), done("CodeQL")], REQUIRED)).toEqual({
      state: "pending",
      waitingOn: ["CI / required (not registered yet)"],
    });
  });

  test("waits for every registered check, not only the required ones", () => {
    expect(evaluateChecks([done("CI / required"), running("image")], REQUIRED)).toEqual({
      state: "pending",
      waitingOn: ["image"],
    });
  });

  test("succeeds once the required checks passed and nothing is outstanding", () => {
    expect(
      evaluateChecks([done("verify"), done("CI / required"), done("scan", "skipped"), done("x", "neutral")], REQUIRED),
    ).toEqual({ state: "success", passed: ["verify", "CI / required", "scan", "x"] });
  });

  test("fails fast on any failed check, even while others are still running", () => {
    const verdict = evaluateChecks([done("verify", "failure"), queued("image")], REQUIRED);
    expect(verdict).toEqual({ state: "failure", failed: [done("verify", "failure")] });
  });

  test.each(["cancelled", "timed_out", "action_required", "startup_failure", "stale"])(
    "treats a %s conclusion as failed",
    (conclusion) => {
      expect(evaluateChecks([done("CI / required", conclusion)], REQUIRED).state).toBe("failure");
    },
  );

  test("a required check that was skipped does not satisfy protection", () => {
    expect(evaluateChecks([done("CI / required", "skipped")], REQUIRED)).toEqual({
      state: "failure",
      failed: [done("CI / required", "skipped")],
    });
  });
});

// A scripted clock + check-run source: each poll returns the next snapshot and sleeping
// advances the clock, so the loop runs instantly and deterministically.
function harness(snapshots: Array<CheckRun[] | Error>) {
  let clock = 0;
  const polledShas: string[] = [];
  const logs: string[] = [];
  let index = 0;
  return {
    polledShas,
    logs,
    options: {
      sha: SHA,
      required: REQUIRED,
      registerTimeoutMs: 60_000,
      totalTimeoutMs: 300_000,
      intervalMs: 20_000,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      log: (line: string) => logs.push(line),
      listCheckRuns: async (sha: string) => {
        polledShas.push(sha);
        const snapshot = snapshots[Math.min(index++, snapshots.length - 1)]!;
        if (snapshot instanceof Error) throw snapshot;
        return snapshot;
      },
    },
  };
}

describe("awaitHeadChecks", () => {
  test("rides out the window right after a push when no check exists yet", async () => {
    const h = harness([[], [], [queued("verify")], [done("verify")], [done("verify"), done("CI / required")]]);
    expect(await awaitHeadChecks(h.options)).toEqual({ ok: true, passed: ["verify", "CI / required"] });
    expect(h.polledShas).toEqual(Array(5).fill(SHA));
  });

  test("gives up when no check is ever registered on the pushed commit", async () => {
    const h = harness([[]]);
    expect(await awaitHeadChecks(h.options)).toEqual({
      ok: false,
      reason: "unregistered",
      waitingOn: REQUIRED,
    });
  });

  test("times out when checks never finish", async () => {
    const h = harness([[running("verify")]]);
    expect(await awaitHeadChecks(h.options)).toEqual({
      ok: false,
      reason: "timeout",
      waitingOn: ["CI / required (not registered yet)", "verify"],
    });
  });

  test("returns the failed checks", async () => {
    const h = harness([[running("verify")], [done("verify", "failure")]]);
    expect(await awaitHeadChecks(h.options)).toEqual({
      ok: false,
      reason: "failure",
      failed: [done("verify", "failure")],
    });
  });

  test("tolerates a transient polling error but not a persistent one", async () => {
    const transient = harness([new Error("HTTP 502"), [done("CI / required")]]);
    expect((await awaitHeadChecks(transient.options)).ok).toBe(true);
    expect(transient.logs.some((line) => line.includes("HTTP 502"))).toBe(true);

    const persistent = harness([new Error("HTTP 403")]);
    await expect(awaitHeadChecks(persistent.options)).rejects.toThrow("HTTP 403");
  });
});

describe("parseArgs", () => {
  test("parses the workflow's invocation with default timeouts", () => {
    expect(parseArgs(["--repo", "gascity/registry", "--sha", SHA, "--require", "CI / required"])).toEqual({
      repo: "gascity/registry",
      sha: SHA,
      required: ["CI / required"],
      registerTimeoutMs: 300_000,
      totalTimeoutMs: 3_600_000,
      intervalMs: 20_000,
    });
  });

  test("rejects a missing required check, an abbreviated SHA and bad timeouts", () => {
    expect(() => parseArgs(["--repo", "o/r", "--sha", SHA])).toThrow("--require");
    expect(() => parseArgs(["--repo", "o/r", "--sha", "a41ccac", "--require", "x"])).toThrow("--sha");
    expect(() => parseArgs(["--repo", "o/r", "--sha", SHA, "--require", "x", "--timeout", "0"])).toThrow(
      "--timeout",
    );
    expect(() => parseArgs(["--bogus", "1"])).toThrow("unknown argument");
  });
});

describe("nextPageUrl", () => {
  test("follows rel=next and stops on the last page", () => {
    expect(
      nextPageUrl('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=3>; rel="last"'),
    ).toBe("https://api.github.com/x?page=2");
    expect(nextPageUrl('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
  });
});

type RefreshWorkflow = {
  concurrency?: unknown;
  jobs: Record<string, { "timeout-minutes"?: number }>;
};

describe("update-registry workflow", () => {
  const workflow = readFileSync(new URL("../.github/workflows/update-registry.yml", import.meta.url), "utf8");
  const parsed = Bun.YAML.parse(workflow) as RefreshWorkflow;

  test("runs one refresh at a time and lets the running one finish", () => {
    // Every run force-pushes the same branch, so an overlapping run replaces the commit the
    // other one is waiting on and that run fails for nothing. Queue the newer run instead of
    // cancelling the older one, which may be about to merge a good refresh.
    expect(parsed.concurrency).toEqual({ group: "update-registry", "cancel-in-progress": false });
  });

  test("stops waiting while the job's one-hour App token can still poll and merge", () => {
    // actions/create-github-app-token mints an installation token that expires after one hour.
    // Polling and `gh pr merge` both fail after that, so the wait and the job end first.
    const helperTimeoutSeconds = Number(/--timeout (\d+)/.exec(workflow)?.[1]);
    const jobTimeoutMinutes = parsed.jobs.update?.["timeout-minutes"];
    expect(helperTimeoutSeconds).toBeLessThanOrEqual(50 * 60);
    expect(jobTimeoutMinutes).toBeDefined();
    expect(jobTimeoutMinutes!).toBeLessThanOrEqual(60);
    expect(jobTimeoutMinutes! * 60).toBeGreaterThan(helperTimeoutSeconds + 5 * 60);
  });

  test("waits on the pushed SHA instead of `gh pr checks --watch`", () => {
    const commands = workflow.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    expect(commands.filter((line) => line.includes("gh pr checks"))).toEqual([]);
    expect(workflow).toContain("bun scripts/await-head-checks.ts");
    expect(workflow).toContain('--sha "$sha"');
  });

  test("merges only the head commit whose checks it watched", () => {
    expect(workflow).toMatch(/gh pr merge "\$pr" --squash --match-head-commit "\$sha"/);
  });
});
