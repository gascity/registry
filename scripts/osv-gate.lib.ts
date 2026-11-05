import { parse } from "smol-toml";

// The verdict logic of scripts/osv-gate.ts (see .github/workflows/osv-scanner.yml).
// A finding blocks when its CVSS score is 7.0 or higher, or, when it carries no
// score, when its advisory labels itself HIGH or CRITICAL, unless one of its ids
// or aliases has an unexpired [[IgnoredVulns]] entry in osv-scanner.toml. An
// expired entry accepts nothing, so a lapsed waiver turns the scan red. A
// known-malicious package (an OSV MAL-* record from the OpenSSF
// malicious-packages feed) always blocks: those records carry no score and no
// label, so the CVSS rule alone would pass them.

export const HIGH_CVSS = 7.0;
const CRITICAL_CVSS = 9.0;
const MEDIUM_CVSS = 4.0;
export const MALICIOUS = "MALICIOUS";
const BLOCKING_LABELS = new Set(["HIGH", "CRITICAL", MALICIOUS]);
const FALLBACK_LABELS = ["CRITICAL", "HIGH", "MODERATE", "MEDIUM", "LOW"];

export class GateInputError extends Error {}

export type Waiver = { id: string; until: string; reason: string };

export type Finding = {
  source: string;
  pkg: string;
  version: string;
  ids: string[];
  severity: string;
  gating: boolean;
};

export type Verdict = {
  blocking: Finding[];
  expired: Map<Finding, Waiver>;
  accepted: Array<[Finding, Waiver]>;
  informational: Finding[];
};

// The subset of osv-scanner's `--format json` report the gate reads.
export type OsvReport = {
  results?: Array<{
    source?: { path?: string };
    packages?: Array<{
      package?: { name?: string; version?: string };
      vulnerabilities?: Array<{ id?: string; database_specific?: { severity?: string } }>;
      groups?: Array<{ ids?: string[]; aliases?: string[]; max_severity?: string }>;
    }>;
  }>;
};

// Every waiver must name an id, expire on a date (YYYY-MM-DD) and say why.
export function parseAllowlist(text: string, where = "osv-scanner.toml"): Waiver[] {
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new GateInputError(`reading allowlist ${where}: ${(error as Error).message}`);
  }
  const entries = (doc.IgnoredVulns ?? []) as Array<Record<string, unknown>>;
  return entries.map((entry, index) => {
    const at = `${where} IgnoredVulns[${index}]`;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) throw new GateInputError(`${at}: id is required`);
    const until = entry.ignoreUntil instanceof Date ? entry.ignoreUntil.toISOString().slice(0, 10) : "";
    if (!until) throw new GateInputError(`${at} (${id}): ignoreUntil must be a date; every waiver expires`);
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (!reason) throw new GateInputError(`${at} (${id}): reason is required`);
    return { id, until, reason };
  });
}

export function labelForScore(score: number): string {
  if (score >= CRITICAL_CVSS) return "CRITICAL";
  if (score >= HIGH_CVSS) return "HIGH";
  if (score >= MEDIUM_CVSS) return "MEDIUM";
  return "LOW";
}

function displayPath(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

export function osvFindings(report: OsvReport, cwd = process.cwd()): Finding[] {
  const findings: Finding[] = [];
  for (const result of report.results ?? []) {
    const source = displayPath(result.source?.path ?? "?", cwd);
    for (const pkg of result.packages ?? []) {
      const labels = new Map((pkg.vulnerabilities ?? []).map((v) => [v.id, (v.database_specific?.severity ?? "").toUpperCase()]));
      for (const group of pkg.groups ?? []) {
        const ids = [...new Set([...(group.ids ?? []), ...(group.aliases ?? [])])];
        if (ids.length === 0) throw new GateInputError(`osv-scanner group without ids in ${source}`);
        let severity = "UNSCORED";
        const raw = (group.max_severity ?? "").trim();
        if (ids.some((id) => id.startsWith("MAL-"))) {
          severity = MALICIOUS;
        } else if (raw) {
          const score = Number(raw);
          if (!Number.isFinite(score)) throw new GateInputError(`osv-scanner max_severity ${JSON.stringify(raw)} is not a number`);
          severity = `${labelForScore(score)} ${raw}`;
        } else {
          const groupLabels = new Set((group.ids ?? []).map((id) => labels.get(id) ?? ""));
          severity = FALLBACK_LABELS.find((label) => groupLabels.has(label)) ?? "UNSCORED";
        }
        findings.push({
          source,
          pkg: pkg.package?.name ?? "?",
          version: pkg.package?.version ?? "?",
          ids,
          severity,
          gating: BLOCKING_LABELS.has(severity.split(" ")[0]!),
        });
      }
    }
  }
  return findings;
}

// today and waiver.until are both YYYY-MM-DD, so string order is date order;
// a waiver still accepts on its expiry day.
export function decide(findings: Finding[], waivers: Waiver[], today: string): Verdict {
  const verdict: Verdict = { blocking: [], expired: new Map(), accepted: [], informational: [] };
  for (const finding of findings) {
    const waiver = waivers.find((w) => finding.ids.includes(w.id));
    if (waiver && today <= waiver.until) verdict.accepted.push([finding, waiver]);
    else if (!finding.gating) verdict.informational.push(finding);
    else {
      if (waiver) verdict.expired.set(finding, waiver);
      verdict.blocking.push(finding);
    }
  }
  return verdict;
}

function row(finding: Finding, note = ""): string {
  return `| \`${finding.source}\` | ${finding.pkg}@${finding.version} | ${finding.ids.join(", ")} | ${finding.severity} | ${note} |`;
}

export function render(verdict: Verdict): string {
  const header = ["| Source | Package | Advisory | Severity | Note |", "|---|---|---|---|---|"];
  const lines = ["## osv-scanner", ""];
  if (verdict.blocking.length > 0) {
    lines.push(
      `**${verdict.blocking.length} unaccepted HIGH/CRITICAL finding(s).** Fix them, or add a time-boxed waiver to osv-scanner.toml in a reviewed change.`,
      "",
      ...header,
      ...verdict.blocking.map((f) => {
        const waiver = verdict.expired.get(f);
        return row(f, waiver ? `waiver ${waiver.id} expired ${waiver.until}` : "blocking");
      }),
    );
  } else {
    lines.push("No unaccepted HIGH/CRITICAL finding.");
  }
  if (verdict.accepted.length > 0) {
    lines.push("", `### Accepted by osv-scanner.toml (${verdict.accepted.length})`, "", ...header);
    lines.push(...verdict.accepted.map(([f, w]) => row(f, `${w.id} until ${w.until}`)));
  }
  if (verdict.informational.length > 0) {
    lines.push("", `### Below the gate (${verdict.informational.length})`, "", ...header);
    lines.push(...verdict.informational.map((f) => row(f)));
  }
  return `${lines.join("\n")}\n`;
}
