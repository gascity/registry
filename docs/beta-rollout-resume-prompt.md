# Resume prompt for the next session

Paste the block below to resume the registry beta-rollout work in a fresh session.

---

We're continuing the **Gas City registry beta rollout + e2e-testing** work. A prior session
delivered P0, P1, P2, P3.1, P3.2 (all verified against real Postgres + e2e + real-gc CLI, nothing
committed). Pick up the remaining phases: **P3.3, P3.4, P4.**

**First, read (in this order):**
1. `docs/beta-rollout-handoff.md` — the session handoff (environment, verification gate, what's
   done, what remains, gotchas, locked decisions). This is your source of truth.
2. `docs/beta-rollout-plan.md` — the full backlog; its "Session progress" section has the concise
   specs for P3.3/P3.4/P4.
3. Your memory notes `registry-beta-rollout`, `registry-architecture-gotchas`,
   `registry-devauth-failclosed`.

**Environment:** work only from `/data/projects/registry/.claude/worktrees/prod` (branch
`worktree-prod`, base `main`). ~27 files are uncommitted from the prior session — **do not commit or
push without an explicit go from me**; if I say go, branch off `main`. A real Postgres is running in
docker on `127.0.0.1:5434` (`registry/registry/registry`); restart it per the handoff if it's gone.

**Process (same pipeline the prior session used — do not skip the red-team):**
- For each phase: **Fable design** (spawn design agents with `model: 'fable'`) → **Opus implement**
  (you, the main loop) → **Fable red-team before merge** (a Fable-based `Workflow`) → fix findings →
  verify. The red-team caught a HIGH bug in every prior phase; run it, especially for P3.4 (deploy/auth)
  and P4 (moderation authz).
- Phased execution: ≤5 files/phase, verify between phases.
- **Verification discipline:** never mark a task done until its verification command has run and you've
  read the result; verify against the **real dependency** (real Postgres via the `REGISTRY_TEST_*` env,
  real `gc`), not a fake. The gate is in the handoff §2. After any `generate`/`build`/`test:e2e`, run
  `git checkout -- public/catalog.json`.

**Start with P3.3** (ingest resilience + offline `generate:check`) — the fully in-repo, verifiable
item. Its concrete spec is in the handoff §4 and the plan doc. Watch the gotchas in handoff §6
(esp. `app.ts` hoisted-functions-after-return, and the `package.json` `test:unit` glob must add
`scripts/*.test.ts`). **Land P3.3 before enabling any auto-promotion in P3.4.**

Give me a short plan for P3.3 first (design), then implement once I confirm.
