import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  type CatalogRenderIssue,
  renderCatalogJsonWithApprovedPublishes,
  renderRegistryTomlWithApprovedPublishes,
} from "./aggregate";
import { createRegistryFetchHandler } from "./app";
import { createStore } from "./store";
import type { ServerConfig } from "./config";
import type { PublishRegistryEntry, PublishRequestRow } from "./types";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const hash = `sha256:${"c".repeat(64)}`;

function entry(name: string, version: string, over: Partial<PublishRegistryEntry["release"]> = {}): PublishRegistryEntry {
  return {
    name,
    description: `${name} pack`,
    source: `https://github.com/x/${name}/tree/main`,
    sourceKind: "git",
    release: {
      version,
      ref: "refs/heads/main",
      commit: commitA,
      hash,
      description: `Release ${name} ${version}`,
      ...over,
    },
  };
}

function approvedRow(id: string, registryEntry: PublishRegistryEntry): PublishRequestRow {
  return { id, status: "approved", registryEntry } as unknown as PublishRequestRow;
}

const baseToml = `schema = 1

[[pack]]
  name = "alpha"
  description = "Alpha pack"
  source = "https://github.com/x/alpha"
  source_kind = "git"

  [[pack.release]]
    version = "1.0.0"
    ref = "refs/heads/main"
    commit = "${commitA}"
    hash = "${hash}"
    description = "alpha 1.0.0"
`;

const baseJson = JSON.stringify({
  schema: 1,
  source_count: 1,
  pack_count: 1,
  sources: [{ name: "gascity-packs", url: "https://example.com/registry.toml", pack_count: 1 }],
  packs: [
    {
      registry: "gascity-packs",
      name: "alpha",
      description: "Alpha pack",
      source: "https://github.com/x/alpha",
      source_kind: "git",
      releases: [
        { version: "1.0.0", ref: "refs/heads/main", commit: commitA, hash, description: "alpha 1.0.0" },
      ],
    },
  ],
});

function collectIssues() {
  const issues: CatalogRenderIssue[] = [];
  return { issues, onIssue: (issue: CatalogRenderIssue) => issues.push(issue) };
}

describe("fail-soft catalog render", () => {
  test("skips a conflicting approved entry but still serves the base + the good entries (TOML)", () => {
    const { issues, onIssue } = collectIssues();
    const approved = [
      approvedRow("prq_good", entry("beta", "1.0.0")),
      // conflicts with base alpha@1.0.0 (different commit)
      approvedRow("prq_bad", entry("alpha", "1.0.0", { commit: commitB })),
    ];
    const toml = renderRegistryTomlWithApprovedPublishes(baseToml, approved, { mode: "fail-soft", onIssue });
    expect(toml).toContain('name = "alpha"');
    expect(toml).toContain('name = "beta"');
    expect(toml).toContain(commitA); // base alpha release kept
    expect(toml).not.toContain(commitB); // conflicting release skipped
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "entry", requestId: "prq_bad", name: "alpha", version: "1.0.0" });
  });

  test("skips a junk approved entry without emitting an `undefined` literal (JSON)", () => {
    const { issues, onIssue } = collectIssues();
    const junk = { ...entry("junk", "1.0.0"), release: { ...entry("junk", "1.0.0").release, version: undefined } };
    const approved = [
      approvedRow("prq_good", entry("beta", "1.0.0")),
      approvedRow("prq_junk", junk as unknown as PublishRegistryEntry),
    ];
    const json = renderCatalogJsonWithApprovedPublishes(baseJson, approved, { mode: "fail-soft", onIssue });
    expect(json).not.toContain("undefined");
    const parsed = JSON.parse(json) as { packs: Array<{ name: string }> };
    expect(parsed.packs.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "entry", requestId: "prq_junk" });
  });

  test("strict mode (the approve-time dry run) still THROWS on a conflict", () => {
    // `alpha` is a BASE pack, so a direct publish claiming that name is now caught as a
    // base collision — earlier and more precisely than the old same-version check.
    const approved = [approvedRow("prq_bad", entry("alpha", "1.0.0", { commit: commitB }))];
    expect(() => renderRegistryTomlWithApprovedPublishes(baseToml, approved)).toThrow(
      /collides with base pack alpha/,
    );
    expect(() => renderCatalogJsonWithApprovedPublishes(baseJson, approved)).toThrow(
      /collides with base pack alpha/,
    );
  });

  test("a direct publish can NEVER graft a release into a same-named first-party pack", () => {
    // The H3 hole: mergeApprovedEntry matched on the flat name, so this release was appended
    // INSIDE the base `alpha` pack and became its `latest`, while the pack still advertised
    // the first-party source. Strict mode must refuse it; fail-soft must skip and report it.
    const { issues, onIssue } = collectIssues();
    const approved = [approvedRow("prq_graft", entry("alpha", "9.9.9", { commit: commitB }))];

    expect(() => renderCatalogJsonWithApprovedPublishes(baseJson, approved)).toThrow(
      /collides with base pack alpha/,
    );

    const json = renderCatalogJsonWithApprovedPublishes(baseJson, approved, { mode: "fail-soft", onIssue });
    const parsed = JSON.parse(json) as {
      packs: Array<{ name: string; registry: string; latest: string; releases: Array<{ commit: string }> }>;
    };
    const alpha = parsed.packs.find((p) => p.name === "alpha")!;
    expect(alpha.registry).toBe("gascity-packs"); // still first-party
    expect(alpha.latest).toBe("1.0.0"); // NOT 9.9.9
    expect(alpha.releases.every((r) => r.commit === commitA)).toBe(true); // no foreign commit
    expect(parsed.packs.filter((p) => p.name === "alpha")).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "entry", requestId: "prq_graft", name: "alpha" });
  });

  test("two publishes whose names flatten to the same pack_key are refused", () => {
    // `a/b` and `a--b` are both individually valid names and both flatten to `direct--a--b`.
    // pack_key keys reviews and ownership, so serving both would silently pool two distinct
    // packs under one identity. The generator treats this as fatal; the serve path must too.
    const approved = [
      approvedRow("prq_scoped", entry("acme/tool", "1.0.0", { commit: commitA })),
      approvedRow("prq_twin", entry("acme--tool", "1.0.0", { commit: commitB })),
    ];
    expect(() => renderCatalogJsonWithApprovedPublishes(baseJson, approved)).toThrow(/pack_key direct--acme--tool/);

    const { issues, onIssue } = collectIssues();
    const json = renderCatalogJsonWithApprovedPublishes(baseJson, approved, { mode: "fail-soft", onIssue });
    const parsed = JSON.parse(json) as { packs: Array<{ pack_key: string }> };
    const keys = parsed.packs.map((p) => p.pack_key);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate pack_key is ever served
    expect(issues).toHaveLength(1);
  });

  test("a base pack claiming registry \"direct\" is not a graft target", () => {
    // normalizeJsonPack copies `registry` straight out of catalog.json, so trusting that string
    // would let a base pack named `direct` become a merge target and re-open the graft hole.
    const poisonedBase = JSON.stringify({
      schema: 1,
      packs: [
        {
          pack_key: "direct--widget",
          registry: "direct",
          name: "widget",
          description: "first-party widget",
          source: "https://github.com/firstparty/widget",
          source_kind: "git",
          releases: [{ version: "1.0.0", ref: "refs/heads/main", commit: commitA, hash, description: "d" }],
        },
      ],
    });
    const approved = [approvedRow("prq_graft2", entry("widget", "9.9.9", { commit: commitB }))];

    expect(() => renderCatalogJsonWithApprovedPublishes(poisonedBase, approved)).toThrow(/collides with base pack/);

    const { issues, onIssue } = collectIssues();
    const json = renderCatalogJsonWithApprovedPublishes(poisonedBase, approved, { mode: "fail-soft", onIssue });
    const parsed = JSON.parse(json) as { packs: Array<{ name: string; latest: string }> };
    expect(parsed.packs.find((p) => p.name === "widget")!.latest).toBe("1.0.0"); // NOT 9.9.9
    expect(issues).toHaveLength(1);
  });

  test("re-approving the identical bits for a version stays idempotent", () => {
    // The withdraw -> reinstate flow deliberately allows a second approved row with identical
    // commit/hash/ref. Without coverage, a regression here silently duplicates releases.
    const same = entry("gamma", "1.0.0", { commit: commitA });
    const approved = [approvedRow("prq_a", same), approvedRow("prq_b", { ...same, release: { ...same.release } })];
    const json = renderCatalogJsonWithApprovedPublishes(baseJson, approved);
    const parsed = JSON.parse(json) as { packs: Array<{ name: string; releases: unknown[] }> };
    expect(parsed.packs.find((p) => p.name === "gamma")!.releases).toHaveLength(1);
  });

  test("two DIRECT entries for the same name@version still conflict on differing bits", () => {
    // Preserves the original same-version guard for the direct-vs-direct case the base
    // collision check does not cover.
    const approved = [
      approvedRow("prq_one", entry("gamma", "1.0.0", { commit: commitA })),
      approvedRow("prq_two", entry("gamma", "1.0.0", { commit: commitB })),
    ];
    expect(() => renderCatalogJsonWithApprovedPublishes(baseJson, approved)).toThrow(
      /conflicts with existing gamma 1\.0\.0/,
    );
  });

  test("falls back to the raw base artifact when the base itself can't parse (fail-soft)", () => {
    const { issues, onIssue } = collectIssues();
    const approved = [approvedRow("prq_good", entry("beta", "1.0.0"))];
    const badBase = "schema = 1\n[[[[ not valid toml";
    const out = renderRegistryTomlWithApprovedPublishes(badBase, approved, { mode: "fail-soft", onIssue });
    expect(out).toBe(badBase); // served unmerged rather than 500
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("base");
  });
});

describe("handler serves a 200 catalog even with a poisoned approved entry", () => {
  test("GET /catalog.json omits the un-renderable approved publish, base + good pack still serve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-aggregate-"));
    const distRoot = join(dir, "dist");
    await mkdir(distRoot, { recursive: true });
    await writeFile(join(distRoot, "registry.toml"), baseToml);
    await writeFile(join(distRoot, "catalog.json"), baseJson);

    const store = createStore(undefined, join(dir, "registry.local.json"));
    await store.init();
    try {
      const admin = await store.ensureUser({
        subject: "dev:admin",
        gasCityUserId: "dev:admin",
        handle: "admin",
        displayName: "Admin",
        assertedAdmin: true,
      });
      const submitter = await store.ensureUser({
        subject: "dev:pub",
        gasCityUserId: "dev:pub",
        handle: "pub",
        displayName: "Pub",
      });

      async function approveWith(name: string, e: PublishRegistryEntry) {
        const req = await store.createPublishRequest(
          submitter.id,
          {
            repoUrl: `https://github.com/x/${name}`,
            commit: e.release.commit,
            packPath: `packs/${name}`,
            requestedName: name,
            requestedVersion: e.release.version,
          },
          "web_session",
        );
        await store.markPublishRequestValidated(req.id, e);
        await store.approvePublishRequest(admin.id, req.id); // store-level approve does no dry run
      }

      // A good new direct-publish, and a poisoned one that conflicts with the BASE alpha@1.0.0
      // (different commit) — the kind of un-renderable row a base change could introduce.
      await approveWith("good-pack", entry("good-pack", "1.0.0"));
      await approveWith("alpha", entry("alpha", "1.0.0", { commit: commitB }));

      const handler = createRegistryFetchHandler({
        config: {
          port: 0,
          appUrl: "http://127.0.0.1:0",
          mountBase: "",
          sessionSecret: "x".repeat(32),
          localDataPath: "",
          publishValidation: { gcBin: "gc", timeoutMs: 1000 },
          isProduction: false,
          devAuthEnabled: false,
        } as ServerConfig,
        store,
        distRoot: pathToFileURL(`${distRoot}/`),
      });

      const res = await handler(new Request("http://127.0.0.1/catalog.json"));
      expect(res.status).toBe(200);
      const parsed = (await res.json()) as { packs: Array<{ name: string; releases: Array<{ commit: string }> }> };
      const names = parsed.packs.map((p) => p.name).sort();
      expect(names).toContain("alpha");
      expect(names).toContain("good-pack");
      const alpha = parsed.packs.find((p) => p.name === "alpha")!;
      expect(alpha.releases.every((r) => r.commit === commitA)).toBe(true); // base kept, poison skipped
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// `gc` runs ValidateCatalog over the whole fetched registry.toml and returns on the FIRST bad
// pack name, so an approved name outside the client grammar is not a one-pack problem: it hides
// every pack, first-party included, from every client. Approve never re-runs
// normalizePublishRequestInput, so this is the only layer that sees an already-queued row.
describe("client-parseable approved entry names", () => {
  const overLong = `acme/${"a".repeat(65)}`;

  test("an over-long approved name is refused in strict mode", () => {
    expect(() =>
      renderCatalogJsonWithApprovedPublishes(baseJson, [approvedRow("prq_long", entry(overLong, "1.0.0"))]),
    ).toThrow(/segment longer than 64 characters/);
    expect(() =>
      renderRegistryTomlWithApprovedPublishes(baseToml, [approvedRow("prq_long", entry(overLong, "1.0.0"))]),
    ).toThrow(/segment longer than 64 characters/);
  });

  test("an over-long approved name is skipped fail-soft, keeping the rest of the catalog", () => {
    const { issues, onIssue } = collectIssues();
    const json = renderCatalogJsonWithApprovedPublishes(
      baseJson,
      [approvedRow("prq_long", entry(overLong, "1.0.0")), approvedRow("prq_ok", entry("acme/tool", "1.0.0"))],
      { mode: "fail-soft", onIssue },
    );
    const parsed = JSON.parse(json) as { packs: Array<{ name: string }> };
    expect(parsed.packs.map((pack) => pack.name)).toEqual(["acme/tool", "alpha"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "entry", requestId: "prq_long" });
  });

  test("an approved name outside the client grammar is refused", () => {
    for (const name of ["Bad Name", "a/b/c", "-lead", "acme/"]) {
      expect(() =>
        renderCatalogJsonWithApprovedPublishes(baseJson, [approvedRow("prq_bad", entry(name, "1.0.0"))]),
      ).toThrow(/is not a valid pack name/);
    }
  });

  // Deliberately looser than the submit grammar: these names predate it and are already served,
  // and `gc` parses them fine. Evicting them here would be a self-inflicted outage.
  //
  // The two length cases pin the guard's semantics against the Go client, which caps each SEGMENT
  // at 64 with no bound on the whole name. Without them, applying the cap per NAME, or an
  // off-by-one to `>=`, both ship green — and either one evicts a served pack. This layer keeps
  // its own copy of `64` precisely so it can diverge from the submit grammar, which is only safe
  // while the copy is independently pinned here.
  test("already-served names the submit grammar would reject still merge", () => {
    for (const name of ["acme--tool", "acme-", "acme-/tool", "a".repeat(64), `acme/${"a".repeat(64)}`]) {
      const json = renderCatalogJsonWithApprovedPublishes(baseJson, [
        approvedRow("prq_legacy", entry(name, "1.0.0")),
      ]);
      const parsed = JSON.parse(json) as { packs: Array<{ name: string }> };
      expect(parsed.packs.map((pack) => pack.name)).toContain(name);
    }
  });
});
