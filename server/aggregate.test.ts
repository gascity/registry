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
import type { PackNameClaim, PublishRegistryEntry, PublishRequestRow } from "./types";

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

// An approved row that carries the repository fields claim precedence measures against the pin.
function approvedRowFrom(
  id: string,
  registryEntry: PublishRegistryEntry,
  repoFullName: string,
  ids: { repositoryId?: string; ownerId?: string } = {},
): PublishRequestRow {
  const [owner = "", name = ""] = repoFullName.split("/");
  return {
    id,
    status: "approved",
    registryEntry,
    repository: { host: "github.com", owner, name, fullName: repoFullName },
    sourceGithubRepositoryId: ids.repositoryId,
    sourceGithubOwnerId: ids.ownerId,
  } as unknown as PublishRequestRow;
}

function claim(name: string, repoFullName: string, ids: { repositoryId?: string; ownerId?: string } = {}): PackNameClaim {
  const [owner = ""] = repoFullName.split("/");
  return {
    name,
    repoFullName,
    githubOwnerLogin: owner,
    githubRepositoryId: ids.repositoryId,
    githubOwnerId: ids.ownerId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function claims(...entries: PackNameClaim[]) {
  return new Map(entries.map((entry) => [entry.name, entry]));
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

// registry-7sn (P0). The base-collision check was exact-name only and always resolved for the
// INGESTED pack, so an upstream source declaring a name a community publisher already holds a
// claim on served UPSTREAM's bits under that name and dropped the claim holder's approved release
// fail-soft. Every community bare name is grandfathered, so the plausible copy-paste mistake
// ("add the community pack to gascity-packs' registry.toml to make it official") is enough.
describe("name-claim precedence over an ingested pack", () => {
  const held = entry("alpha", "9.9.9", { commit: commitB });

  test("the claim holder is served under the name, and the ingested pack is dropped (JSON)", () => {
    const { issues, onIssue } = collectIssues();
    const approved = [approvedRowFrom("prq_holder", held, "x/alpha")];
    const json = renderCatalogJsonWithApprovedPublishes(baseJson, approved, {
      mode: "fail-soft",
      onIssue,
      nameClaims: claims(claim("alpha", "x/alpha")),
    });
    const parsed = JSON.parse(json) as {
      sources: Array<{ name: string; pack_count: number }>;
      packs: Array<{ name: string; registry: string; source: string; latest: string; releases: Array<{ commit: string }> }>;
    };
    const alpha = parsed.packs.filter((pack) => pack.name === "alpha");
    expect(alpha).toHaveLength(1); // never two packs under one name
    expect(alpha[0]).toMatchObject({
      registry: "direct",
      source: "https://github.com/x/alpha/tree/main",
      latest: "9.9.9",
    });
    expect(alpha[0].releases.some((release) => release.commit === commitA)).toBe(false); // no upstream bits
    // The dropped pack is not still counted against the source that declared it.
    expect(parsed.sources.find((source) => source.name === "gascity-packs")?.pack_count).toBe(0);
    expect(parsed.sources.find((source) => source.name === "direct")?.pack_count).toBe(1);
    // ...and the first-party operator gets told, because ingest has no database and no other
    // channel would ever tell them their entry is being ignored.
    expect(issues).toEqual([
      {
        kind: "base-ignored",
        requestId: "prq_holder",
        name: "alpha",
        baseRegistry: "gascity-packs",
        claimedBy: "x/alpha",
      },
    ]);
  });

  test("...and identically in STRICT mode, so approve cannot 409 what the serve path merges", () => {
    // Asymmetry here would mean an upstream edit silently freezing the claim holder's releases.
    const { issues, onIssue } = collectIssues();
    const toml = renderRegistryTomlWithApprovedPublishes(
      baseToml,
      [approvedRowFrom("prq_holder", held, "x/alpha")],
      { onIssue, nameClaims: claims(claim("alpha", "x/alpha")) },
    );
    expect(toml).toContain('source = "https://github.com/x/alpha/tree/main"');
    expect(toml).not.toContain('source = "https://github.com/x/alpha"\n'); // the ingested pack is gone
    expect(toml).toContain(commitB);
    expect(toml).not.toContain(commitA);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("base-ignored");
  });

  // The other half of the guard: precedence belongs to the pin's holder, NOT to whoever holds an
  // approved row for the name. Anything short of a held claim leaves the ingested pack alone.
  test("an approved entry that does not hold the name's claim never displaces the ingested pack", () => {
    const cases: Array<{ label: string; row: PublishRequestRow; nameClaims?: Map<string, PackNameClaim> }> = [
      { label: "no claims read at all", row: approvedRowFrom("prq_a", held, "x/alpha") },
      { label: "no claim on this name", row: approvedRowFrom("prq_b", held, "x/alpha"), nameClaims: claims(claim("other", "x/other")) },
      {
        label: "claim pinned to another repo",
        row: approvedRowFrom("prq_c", held, "evil/alpha"),
        nameClaims: claims(claim("alpha", "x/alpha")),
      },
      {
        // Same repo full name, different GitHub repository id: the pin is written in ids, so a
        // name compare alone would admit a re-created/forked repo squatting the old name.
        label: "claim pinned to another repository id",
        row: approvedRowFrom("prq_d", held, "x/alpha", { repositoryId: "repo_new", ownerId: "owner_x" }),
        nameClaims: claims(claim("alpha", "x/alpha", { repositoryId: "repo_old", ownerId: "owner_x" })),
      },
      {
        // A row that cannot answer the pin at all (no repository) must fail CLOSED, not throw a
        // TypeError out of the strict-mode dry run and 409 an unrelated approve.
        label: "row carries no repository",
        row: approvedRow("prq_e", held),
        nameClaims: claims(claim("alpha", "x/alpha")),
      },
    ];

    for (const { label, row, nameClaims } of cases) {
      expect(() =>
        renderCatalogJsonWithApprovedPublishes(baseJson, [row], { nameClaims }),
      ).toThrow(/collides with base pack alpha from source gascity-packs/);

      const { issues, onIssue } = collectIssues();
      const json = renderCatalogJsonWithApprovedPublishes(baseJson, [row], {
        mode: "fail-soft",
        onIssue,
        nameClaims,
      });
      const parsed = JSON.parse(json) as {
        packs: Array<{ name: string; registry: string; latest: string; releases: Array<{ commit: string }> }>;
      };
      const alpha = parsed.packs.find((pack) => pack.name === "alpha")!;
      expect(alpha.registry, label).toBe("gascity-packs"); // ingested pack untouched
      expect(alpha.latest, label).toBe("1.0.0");
      expect(alpha.releases.every((release) => release.commit === commitA), label).toBe(true);
      expect(issues.map((issue) => issue.kind), label).toEqual(["entry"]);
    }
  });

  // Claim precedence is scoped to the SAME-NAME collision on purpose. A claim on `acme/tool` proves
  // nothing about the different name `acme--tool`, and dropping that pack would evict a name
  // clients pin — so a pack_key collision stays fatal no matter who holds what.
  test("a pack_key collision with an ingested pack is never resolved by a claim", () => {
    const poisonedBase = JSON.stringify({
      schema: 1,
      sources: [{ name: "direct", url: "u", pack_count: 1 }],
      packs: [
        {
          pack_key: "direct--acme--tool",
          registry: "direct",
          name: "acme--tool",
          description: "ingested twin",
          source: "https://github.com/firstparty/acme-tool",
          source_kind: "git",
          releases: [{ version: "1.0.0", ref: "refs/heads/main", commit: commitA, hash, description: "d" }],
        },
      ],
    });
    const scoped = entry("acme/tool", "9.9.9", { commit: commitB });
    const row = approvedRowFrom("prq_key", scoped, "acme/tool");

    for (const nameClaims of [undefined, claims(claim("acme/tool", "acme/tool"))]) {
      expect(() => renderCatalogJsonWithApprovedPublishes(poisonedBase, [row], { nameClaims })).toThrow(
        /collides with base pack acme--tool/,
      );

      const { issues, onIssue } = collectIssues();
      const json = renderCatalogJsonWithApprovedPublishes(poisonedBase, [row], {
        mode: "fail-soft",
        onIssue,
        nameClaims,
      });
      const parsed = JSON.parse(json) as { packs: Array<{ pack_key: string; name: string; latest: string }> };
      const keys = parsed.packs.map((pack) => pack.pack_key);
      expect(new Set(keys).size).toBe(keys.length); // one pack_key, one pack — always
      expect(parsed.packs.find((pack) => pack.name === "acme--tool")!.latest).toBe("1.0.0");
      expect(issues.map((issue) => issue.kind)).toEqual(["entry"]);
    }
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

      // A good new direct-publish, and a poisoned one carrying an un-renderable registry_entry
      // (no hash) under the BASE pack's name — the kind of row a backfill or a schema change can
      // leave behind. Deliberately NOT a plain name collision: a store-level approve mints the
      // name claim, so a same-named row from its own repo IS the claim holder and is now served
      // over the base pack on purpose (see the claim-precedence test below).
      await approveWith("good-pack", entry("good-pack", "1.0.0"));
      await approveWith("alpha", entry("alpha", "1.0.0", { commit: commitB, hash: "" }));

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
