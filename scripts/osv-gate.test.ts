import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, GateInputError, osvFindings, parseAllowlist, render, type Finding, type OsvReport } from "./osv-gate.lib";

const TODAY = "2026-11-05";

function report(groups: NonNullable<NonNullable<NonNullable<OsvReport["results"]>[number]["packages"]>[number]["groups"]>, vulnerabilities = []): OsvReport {
  return {
    results: [
      {
        source: { path: "/repo/bun.lock" },
        packages: [{ package: { name: "pkg", version: "1.0.0" }, vulnerabilities, groups }],
      },
    ],
  };
}

function finding(ids: string[], gating = true): Finding {
  return { source: "bun.lock", pkg: "p", version: "1", ids, severity: gating ? "HIGH 7.5" : "MEDIUM 5.0", gating };
}

describe("allowlist", () => {
  test("reads id, expiry date and reason", () => {
    const waivers = parseAllowlist('[[IgnoredVulns]]\nid = "CVE-1"\nignoreUntil = 2027-01-26\nreason = "unused path"\n');
    expect(waivers).toEqual([{ id: "CVE-1", until: "2027-01-26", reason: "unused path" }]);
  });

  test("the shipped osv-scanner.toml parses", () => {
    const text = readFileSync(new URL("../osv-scanner.toml", import.meta.url), "utf8");
    expect(() => parseAllowlist(text)).not.toThrow();
  });

  test("rejects a waiver with no expiry", () => {
    expect(() => parseAllowlist('[[IgnoredVulns]]\nid = "CVE-1"\nreason = "r"\n')).toThrow(/every waiver expires/);
  });

  test("rejects a waiver with no reason", () => {
    expect(() => parseAllowlist('[[IgnoredVulns]]\nid = "CVE-1"\nignoreUntil = 2027-01-26\n')).toThrow(/reason is required/);
  });

  test("rejects malformed TOML as an input error", () => {
    expect(() => parseAllowlist("[[IgnoredVulns]\n")).toThrow(GateInputError);
  });
});

describe("osv-scanner findings", () => {
  test("gates at CVSS 7.0 and labels by score", () => {
    const findings = osvFindings(
      report([
        { ids: ["GHSA-a"], aliases: ["CVE-1", "GHSA-a"], max_severity: "9.4" },
        { ids: ["GHSA-b"], max_severity: "7.0" },
        { ids: ["GHSA-c"], max_severity: "6.9" },
      ]),
      "/repo",
    );
    expect(findings.map((f) => [f.severity, f.gating])).toEqual([
      ["CRITICAL 9.4", true],
      ["HIGH 7.0", true],
      ["MEDIUM 6.9", false],
    ]);
    expect(findings[0]!.ids).toEqual(["GHSA-a", "CVE-1"]);
    expect(findings[0]!.source).toBe("bun.lock");
  });

  test("falls back to the advisory's own label when unscored", () => {
    const findings = osvFindings(
      report(
        [{ ids: ["GHSA-high"], max_severity: "" }, { ids: ["GHSA-none"] }],
        [{ id: "GHSA-high", database_specific: { severity: "HIGH" } }, { id: "GHSA-none" }] as never,
      ),
    );
    expect(findings.map((f) => [f.severity, f.gating])).toEqual([
      ["HIGH", true],
      ["UNSCORED", false],
    ]);
  });

  test("a clean report has no findings", () => {
    expect(osvFindings({ results: [] })).toEqual([]);
    expect(osvFindings({})).toEqual([]);
  });

  test("a non-numeric score is an input error", () => {
    expect(() => osvFindings(report([{ ids: ["X"], max_severity: "high" }]))).toThrow(GateInputError);
  });
});

describe("verdict", () => {
  test("an active waiver accepts through an alias", () => {
    const verdict = decide([finding(["GHSA-x", "CVE-1"])], [{ id: "CVE-1", until: "2027-01-26", reason: "r" }], TODAY);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.accepted).toHaveLength(1);
  });

  test("a waiver still accepts on its expiry day and not after", () => {
    const waivers = [{ id: "CVE-1", until: TODAY, reason: "r" }];
    expect(decide([finding(["CVE-1"])], waivers, TODAY).blocking).toEqual([]);
    const lapsed = decide([finding(["CVE-1"])], waivers, "2026-11-06");
    expect(lapsed.blocking).toHaveLength(1);
    expect(render(lapsed)).toContain(`waiver CVE-1 expired ${TODAY}`);
  });

  test("an unwaived HIGH blocks and a MEDIUM does not", () => {
    const verdict = decide([finding(["GHSA-new"]), finding(["GHSA-med"], false)], [], TODAY);
    expect(verdict.blocking.map((f) => f.ids[0])).toEqual(["GHSA-new"]);
    expect(verdict.informational.map((f) => f.ids[0])).toEqual(["GHSA-med"]);
  });
});

describe("CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "osv-gate-"));
  const allowlist = join(dir, "osv-scanner.toml");
  writeFileSync(allowlist, '[[IgnoredVulns]]\nid = "CVE-1"\nignoreUntil = 2027-01-26\nreason = "accepted"\n');

  function run(...args: string[]) {
    const proc = Bun.spawnSync(["bun", new URL("./osv-gate.ts", import.meta.url).pathname, "--allowlist", allowlist, "--today", TODAY, ...args]);
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  }

  test("an accepted HIGH passes and is written to the summary", () => {
    const osv = join(dir, "accepted.json");
    const summary = join(dir, "summary.md");
    writeFileSync(osv, JSON.stringify(report([{ ids: ["GHSA-x"], aliases: ["CVE-1"], max_severity: "8.1" }])));
    const result = run("--osv", osv, "--summary", summary);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Accepted by osv-scanner.toml (1)");
    expect(readFileSync(summary, "utf8")).toBe(result.out);
  });

  test("an unaccepted CRITICAL fails", () => {
    const osv = join(dir, "critical.json");
    writeFileSync(osv, JSON.stringify(report([{ ids: ["GHSA-new"], max_severity: "9.8" }])));
    const result = run("--osv", osv);
    expect(result.code).toBe(1);
    expect(result.out).toContain("GHSA-new");
  });

  test("a missing report exits 2", () => {
    const result = run("--osv", join(dir, "absent.json"));
    expect(result.code).toBe(2);
    expect(result.err).toContain("absent.json");
  });
});

describe("osv-scanner.yml", () => {
  type Step = { name?: string; run?: string; uses?: string; with?: Record<string, string> };
  type Job = { permissions?: Record<string, string>; steps?: Step[] };
  const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/osv-scanner.yml", import.meta.url), "utf8")) as {
    on: Record<string, unknown>;
    env: Record<string, string>;
    jobs: Record<string, Job>;
  };
  const scan = workflow.jobs.scan!;
  const runs = (scan.steps ?? []).map((step) => step.run ?? "").join("\n");

  test("runs weekly as well as on pushes and pull requests", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "schedule", "workflow_dispatch"]);
  });

  test("grants security-events: write to the scan job only", () => {
    expect(scan.permissions).toEqual({ contents: "read", packages: "read", "security-events": "write" });
  });

  test("verifies the pinned scanner binary", () => {
    expect(workflow.env.OSV_SCANNER_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(workflow.env.OSV_SCANNER_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(runs).toContain("sha256sum -c -");
  });

  test("applies the allowlist, requires bun.lock in the scan and gates on the report", () => {
    expect(runs).toContain("--config osv-scanner.toml");
    expect(runs).toContain('endswith("/bun.lock")');
    expect(runs).toContain("bun scripts/osv-gate.ts");
    const upload = (scan.steps ?? []).find((step) => step.uses?.startsWith("github/codeql-action/upload-sarif@"));
    expect(upload?.with?.sarif_file).toBe("osv-results/osv-scanner.sarif");
  });
});
