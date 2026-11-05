// Fails .github/workflows/osv-scanner.yml on a HIGH/CRITICAL finding that
// osv-scanner.toml does not accept (rules in scripts/osv-gate.lib.ts).
//
//   bun scripts/osv-gate.ts --allowlist osv-scanner.toml --osv report.json [--summary FILE] [--today YYYY-MM-DD]
//
// Exit status: 0 when nothing blocks, 1 when something does, 2 when the report
// or the allowlist cannot be read.

import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decide, GateInputError, osvFindings, parseAllowlist, render, type OsvReport } from "./osv-gate.lib";

function read(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new GateInputError(`reading ${what} ${path}: ${(error as Error).message}`);
  }
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      allowlist: { type: "string" },
      osv: { type: "string" },
      summary: { type: "string" },
      today: { type: "string" },
    },
  });
  try {
    if (!values.allowlist || !values.osv) throw new GateInputError("--allowlist and --osv are required");
    const today = values.today ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new GateInputError(`--today wants YYYY-MM-DD, got ${today}`);
    const waivers = parseAllowlist(read(values.allowlist, "allowlist"), values.allowlist);
    let report: OsvReport;
    try {
      report = JSON.parse(read(values.osv, "osv-scanner report")) as OsvReport;
    } catch (error) {
      if (error instanceof GateInputError) throw error;
      throw new GateInputError(`parsing osv-scanner report ${values.osv}: ${(error as Error).message}`);
    }
    const verdict = decide(osvFindings(report), waivers, today);
    const markdown = render(verdict);
    process.stdout.write(markdown);
    if (values.summary) appendFileSync(values.summary, markdown);
    return verdict.blocking.length > 0 ? 1 : 0;
  } catch (error) {
    if (!(error instanceof GateInputError)) throw error;
    console.error(`osv-gate: ${error.message}`);
    return 2;
  }
}

process.exit(main(process.argv.slice(2)));
