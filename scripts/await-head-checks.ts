// Waits for the checks on ONE commit to register and finish, then exits 0 only if every
// required check passed and nothing failed.
//
// The aggregate refresh force-pushes its branch and must not merge until CI is green on the
// commit it just pushed. `gh pr checks --watch` cannot do that: it exits "no checks reported"
// when it runs before GitHub has registered any check for the new head, and it resolves the
// PR's head at call time, so it can also observe the previous head's (stale) checks. Keying
// every poll on the pushed SHA rules out stale checks, and requiring the named checks to
// appear rules out declaring victory in the gap before a dependent job's check exists.

/** A check run as reported by GET /repos/{repo}/commits/{sha}/check-runs (latest per name). */
export type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
};

/** One poll's verdict over the check runs registered for the commit. */
export type Verdict =
  | { state: "unregistered" }
  | { state: "pending"; waitingOn: string[] }
  | { state: "success"; passed: string[] }
  | { state: "failure"; failed: CheckRun[] };

// Conclusions that do not block a merge. Everything else that is completed (failure,
// cancelled, timed_out, action_required, startup_failure, stale) counts as failed.
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** Classifies the check runs for one commit against the checks that must pass. */
export function evaluateChecks(runs: CheckRun[], required: string[]): Verdict {
  if (runs.length === 0) return { state: "unregistered" };

  const failed = runs.filter(
    (run) => run.status === "completed" && !PASSING_CONCLUSIONS.has(run.conclusion ?? ""),
  );
  if (failed.length > 0) return { state: "failure", failed };

  const byName = new Map(runs.map((run) => [run.name, run]));
  const missingRequired = required.filter((name) => !byName.has(name));
  const incomplete = runs.filter((run) => run.status !== "completed").map((run) => run.name);
  const waitingOn = [...missingRequired.map((name) => `${name} (not registered yet)`), ...incomplete];
  if (waitingOn.length > 0) return { state: "pending", waitingOn };

  const requiredNotPassed = required.filter((name) => byName.get(name)?.conclusion !== "success");
  if (requiredNotPassed.length > 0) {
    return { state: "failure", failed: requiredNotPassed.map((name) => byName.get(name)!) };
  }
  return { state: "success", passed: runs.map((run) => run.name) };
}

/** Options for awaitHeadChecks. Times are milliseconds. */
export type AwaitOptions = {
  sha: string;
  required: string[];
  listCheckRuns: (sha: string) => Promise<CheckRun[]>;
  /** How long to wait for the first check to be registered on the commit. */
  registerTimeoutMs: number;
  /** How long to wait, in total, for the checks to finish. */
  totalTimeoutMs: number;
  intervalMs: number;
  /** Consecutive failed polls tolerated (e.g. a transient 5xx) before giving up. */
  maxConsecutiveErrors?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

/** The final outcome: success, a failed check, or a timeout (with what it was waiting on). */
export type AwaitResult =
  | { ok: true; passed: string[] }
  | { ok: false; reason: "failure"; failed: CheckRun[] }
  | { ok: false; reason: "unregistered" | "timeout"; waitingOn: string[] };

/** Polls the commit's check runs until they settle or a timeout elapses. */
export async function awaitHeadChecks(options: AwaitOptions): Promise<AwaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = options.log ?? ((line: string) => console.log(line));
  const started = now();
  const maxConsecutiveErrors = options.maxConsecutiveErrors ?? 3;
  let consecutiveErrors = 0;
  let lastWaitingOn = "";

  for (;;) {
    let runs: CheckRun[];
    try {
      runs = await options.listCheckRuns(options.sha);
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxConsecutiveErrors) throw error;
      log(`::warning::polling checks on ${options.sha} failed (${consecutiveErrors}/${maxConsecutiveErrors}): ${error instanceof Error ? error.message : String(error)}`);
      await sleep(options.intervalMs);
      continue;
    }
    const verdict = evaluateChecks(runs, options.required);
    const elapsed = now() - started;
    switch (verdict.state) {
      case "success":
        return { ok: true, passed: verdict.passed };
      case "failure":
        return { ok: false, reason: "failure", failed: verdict.failed };
      case "unregistered":
        if (elapsed >= options.registerTimeoutMs) {
          return { ok: false, reason: "unregistered", waitingOn: options.required };
        }
        if (lastWaitingOn !== "<none>") log(`no checks registered on ${options.sha} yet`);
        lastWaitingOn = "<none>";
        break;
      case "pending": {
        if (elapsed >= options.totalTimeoutMs) {
          return { ok: false, reason: "timeout", waitingOn: verdict.waitingOn };
        }
        const summary = verdict.waitingOn.join(", ");
        if (summary !== lastWaitingOn) log(`waiting on: ${summary}`);
        lastWaitingOn = summary;
        break;
      }
    }
    await sleep(options.intervalMs);
  }
}

/** Parsed command-line arguments. */
export type CliArgs = {
  repo: string;
  sha: string;
  required: string[];
  registerTimeoutMs: number;
  totalTimeoutMs: number;
  intervalMs: number;
};

const SECONDS = 1000;

/** Parses `--repo owner/name --sha <40-hex> --require <check> [...]` plus optional timeouts. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    repo: "",
    sha: "",
    required: [],
    registerTimeoutMs: 300 * SECONDS,
    totalTimeoutMs: 3600 * SECONDS,
    intervalMs: 20 * SECONDS,
  };
  const seconds = (flag: string, value: string) => {
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${flag} must be a positive whole number of seconds`);
    return Number(value) * SECONDS;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    index += 1;
    switch (flag) {
      case "--repo":
        args.repo = value;
        break;
      case "--sha":
        args.sha = value;
        break;
      case "--require":
        args.required.push(value);
        break;
      case "--register-timeout":
        args.registerTimeoutMs = seconds(flag, value);
        break;
      case "--timeout":
        args.totalTimeoutMs = seconds(flag, value);
        break;
      case "--interval":
        args.intervalMs = seconds(flag, value);
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(args.repo)) throw new Error("--repo must be owner/name");
  if (!/^[0-9a-f]{40}$/.test(args.sha)) throw new Error("--sha must be a full 40-character commit SHA");
  if (args.required.length === 0) throw new Error("at least one --require check name is needed");
  return args;
}

/** Returns the rel="next" URL from a GitHub Link header, if any. */
export function nextPageUrl(link: string | null): string | null {
  for (const part of (link ?? "").split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1]!;
  }
  return null;
}

function githubCheckRunLister(repo: string, token: string, apiUrl: string) {
  return async (sha: string): Promise<CheckRun[]> => {
    const runs: CheckRun[] = [];
    let url: string | null = `${apiUrl}/repos/${repo}/commits/${sha}/check-runs?per_page=100`;
    while (url) {
      const response: Response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!response.ok) {
        throw new Error(`listing check runs for ${sha}: HTTP ${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as { check_runs: CheckRun[] };
      runs.push(...body.check_runs);
      url = nextPageUrl(response.headers.get("link"));
    }
    return runs;
  };
}

function formatRun(run: CheckRun): string {
  return `${run.name}: ${run.status === "completed" ? run.conclusion : run.status}${run.html_url ? ` (${run.html_url})` : ""}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!token) throw new Error("GH_TOKEN (or GITHUB_TOKEN) is required");
  const apiUrl = (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/$/, "");

  console.log(`awaiting checks on ${args.repo}@${args.sha}; required: ${args.required.join(", ")}`);
  const result = await awaitHeadChecks({
    ...args,
    listCheckRuns: githubCheckRunLister(args.repo, token, apiUrl),
  });
  if (result.ok) {
    console.log(`all checks passed on ${args.sha}: ${result.passed.join(", ")}`);
    return 0;
  }
  if (result.reason === "failure") {
    console.error(`checks failed on ${args.sha}:\n${result.failed.map((run) => `  ${formatRun(run)}`).join("\n")}`);
  } else if (result.reason === "unregistered") {
    console.error(`no checks were registered on ${args.sha} within ${args.registerTimeoutMs / SECONDS}s`);
  } else {
    console.error(`timed out after ${args.totalTimeoutMs / SECONDS}s waiting on: ${result.waitingOn.join(", ")}`);
  }
  return 1;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    },
  );
}
