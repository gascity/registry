import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/promote.yml", import.meta.url),
  "utf8",
);

describe("production promotion workflow", () => {
  test("PROMOTE_PAUSED gates the job before any image retag step can run", () => {
    const promoteJob = workflow.split(/^  promote:\s*$/m)[1];
    expect(promoteJob).toBeDefined();

    const beforeSteps = promoteJob!.split(/^    steps:\s*$/m)[0];
    expect(beforeSteps).toContain("vars.PROMOTE_PAUSED != 'true'");
    expect(promoteJob).not.toContain("name: Kill switch");
  });
});
