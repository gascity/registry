import { parse } from "smol-toml";
import { nameClaimMatchesRequest } from "./publish";
import type { PackNameClaim, PublishRegistryEntry, PublishRequestRow } from "./types";

type RuntimeRelease = {
  version: string;
  ref: string;
  commit: string;
  hash: string;
  description: string;
  withdrawn?: boolean;
  withdrawnReason?: string;
};

type RuntimePack = {
  registry: string;
  name: string;
  description: string;
  source: string;
  sourceKind: string;
  readme?: unknown;
  ogImage?: string;
  releases: RuntimeRelease[];
};

type RawTomlCatalog = {
  schema?: unknown;
  pack?: unknown;
};

type RawTomlPack = {
  name?: unknown;
  description?: unknown;
  source?: unknown;
  source_kind?: unknown;
  release?: unknown;
};

type RawTomlRelease = {
  version?: unknown;
  ref?: unknown;
  commit?: unknown;
  hash?: unknown;
  description?: unknown;
  withdrawn?: unknown;
  withdrawn_reason?: unknown;
};

type RawJsonCatalog = {
  schema?: unknown;
  source_count?: unknown;
  pack_count?: unknown;
  sources?: unknown;
  og_image?: unknown;
  packs?: unknown;
};

type RawJsonPack = {
  registry?: unknown;
  name?: unknown;
  description?: unknown;
  source?: unknown;
  source_kind?: unknown;
  readme?: unknown;
  og_image?: unknown;
  releases?: unknown;
};

export type CatalogRenderIssue =
  | { kind: "base"; error: Error }
  | { kind: "entry"; requestId: string; name: string; version: string; error: Error }
  // An INGESTED (first-party) pack was dropped from the served catalog because the name it
  // declares belongs to the direct publisher whose approved release we served under it instead.
  // Not a failure — nothing is retried and nothing is degraded — but it is reported in BOTH modes
  // because the operator who added that upstream entry has no other channel that would ever tell
  // them it is being ignored.
  | { kind: "base-ignored"; requestId: string; name: string; baseRegistry: string; claimedBy: string };

export type RenderOptions = {
  // "strict" (default): any un-mergeable approved entry throws — the approve-time dry run
  // (assertPublishRequestCanMerge) relies on this to REJECT conflicts at approve time.
  // "fail-soft": skip the bad entry / fall back to the base artifact and report via onIssue.
  // Only the public serve path opts into fail-soft, so one poisoned approved publish can never
  // 500 /registry.toml + /catalog.json for everyone.
  mode?: "strict" | "fail-soft";
  onIssue?: (issue: CatalogRenderIssue) => void;
  // pack_name_claims rows for the names being merged, keyed by name, read from the store by the
  // CALLER — this module stays DB-free so both artifacts render from one pure function and every
  // branch below is unit-testable. A name that is absent from the map is treated as UNCLAIMED,
  // which keeps the base artifact's pack: the fail-closed direction, since the hazard being closed
  // is serving OTHER bits under a claimed name.
  nameClaims?: ReadonlyMap<string, PackNameClaim>;
};

// The request row travels with the entry because claim precedence has to measure the SUBMISSION
// against the name's pin (repo ids / owner login), not just the entry it produced.
type ApprovedEntry = { requestId: string; request: PublishRequestRow; entry: PublishRegistryEntry };

// One base (ingested) pack that claim precedence dropped from the served catalog.
type IgnoredBasePack = { name: string; baseRegistry: string; claimedBy: string };

export function renderRegistryTomlWithApprovedPublishes(
  baseToml: string,
  requests: PublishRequestRow[],
  options: RenderOptions = {},
) {
  const entries = approvedEntries(requests);
  if (entries.length === 0) return baseToml;
  let basePacks: RuntimePack[];
  try {
    basePacks = readTomlPacks(baseToml);
  } catch (error) {
    if (options.mode !== "fail-soft") throw error;
    options.onIssue?.({ kind: "base", error: asError(error) });
    return baseToml; // serve the committed artifact unmerged rather than 500
  }
  return renderRegistryToml(mergeApprovedEntries(basePacks, entries, options));
}

export function renderCatalogJsonWithApprovedPublishes(
  baseJson: string,
  requests: PublishRequestRow[],
  options: RenderOptions = {},
) {
  const entries = approvedEntries(requests);
  if (entries.length === 0) return baseJson;
  let raw: RawJsonCatalog;
  let basePacks: RuntimePack[];
  try {
    raw = JSON.parse(baseJson) as RawJsonCatalog;
    basePacks = readJsonPacks(raw);
  } catch (error) {
    if (options.mode !== "fail-soft") throw error;
    options.onIssue?.({ kind: "base", error: asError(error) });
    return baseJson;
  }
  const packs = mergeApprovedEntries(basePacks, entries, options);
  const directPackCount = packs.filter((pack) => pack.registry === "direct").length;
  const baseSources = (Array.isArray(raw.sources) ? raw.sources : []).map((source) =>
    withServedPackCount(source, packs),
  );
  const sources =
    directPackCount > 0
      ? [
          ...baseSources,
          {
            name: "direct",
            url: "registry://direct-publish",
            pack_count: directPackCount,
          },
        ]
      : baseSources;

  return `${JSON.stringify(
    {
      schema: 1,
      source_count: sources.length,
      pack_count: packs.length,
      sources,
      og_image: typeof raw.og_image === "string" ? raw.og_image : "/og/registry.svg",
      packs: packs.map(catalogJsonPack),
    },
    null,
    2,
  )}\n`;
}

function approvedEntries(requests: PublishRequestRow[]): ApprovedEntry[] {
  return requests
    .filter((request) => request.status === "approved" && request.registryEntry)
    .map((request) => ({
      requestId: request.id,
      request,
      entry: request.registryEntry as PublishRegistryEntry,
    }));
}

function mergeApprovedEntries(basePacks: RuntimePack[], entries: ApprovedEntry[], options: RenderOptions) {
  const packs = basePacks.map((pack) => ({ ...pack, releases: [...pack.releases] }));
  // Identity is tracked structurally, not by trusting the base artifact's `registry` string:
  // normalizeJsonPack copies that field straight out of catalog.json, so a base pack claiming
  // registry "direct" would otherwise be treated as a merge target and re-open the graft hole.
  // `baseByName` + `basePackKeys` are every identity that existed before merging, keyed the two
  // ways a new entry can collide with one; `directPacks` holds only the packs THIS merge created,
  // which are the sole legitimate targets for a later release. Both base maps are built once and
  // maintained by the merge (claim precedence removes from them), rather than re-derived from an
  // index range on `packs` — that arithmetic silently mis-identifies a base pack the moment the
  // array can shrink.
  const baseByName = new Map<string, RuntimePack>();
  const basePackKeys = new Map<string, RuntimePack>();
  for (const pack of packs) {
    baseByName.set(pack.name, pack);
    basePackKeys.set(packKeyFor(pack), pack);
  }
  const directPacks = new Map<string, RuntimePack>();
  for (const { requestId, request, entry } of entries) {
    try {
      const ignored = mergeApprovedEntry(packs, entry, {
        request,
        baseByName,
        basePackKeys,
        directPacks,
        nameClaims: options.nameClaims,
      });
      if (ignored) options.onIssue?.({ kind: "base-ignored", requestId, ...ignored });
    } catch (error) {
      if (options.mode !== "fail-soft") throw error;
      options.onIssue?.({
        kind: "entry",
        requestId,
        name: typeof entry?.name === "string" ? entry.name : "(unknown)",
        version: typeof entry?.release?.version === "string" ? entry.release.version : "(unknown)",
        error: asError(error),
      });
    }
  }
  packs.sort((left, right) => left.name.localeCompare(right.name));
  for (const pack of packs) {
    pack.releases.sort((left, right) => compareVersions(left.version, right.version));
  }
  return packs;
}

// Merge one approved direct-publish entry. Re-validates the stored registry_entry BEFORE any
// mutation (a junk row must not reach the renderer — quote(undefined) would emit a literal
// `undefined`), so a skipped entry in fail-soft mode leaves zero partial state. Returns the base
// pack claim precedence dropped, if any, for the caller to report.
function mergeApprovedEntry(
  packs: RuntimePack[],
  entry: PublishRegistryEntry,
  ctx: {
    request: PublishRequestRow;
    baseByName: Map<string, RuntimePack>;
    basePackKeys: Map<string, RuntimePack>;
    directPacks: Map<string, RuntimePack>;
    nameClaims?: ReadonlyMap<string, PackNameClaim>;
  },
): IgnoredBasePack | undefined {
  const name = requireString(entry?.name, "approved entry name");
  assertClientParseablePackName(name);
  const release = entry?.release ?? ({} as PublishRegistryEntry["release"]);
  const version = requireString(release?.version, `${name} release version`);
  requireString(entry.description, `${name} description`);
  requireString(entry.source, `${name} source`);
  requireString(entry.sourceKind, `${name} sourceKind`);
  requireString(release.ref, `${name}@${version} ref`);
  requireString(release.commit, `${name}@${version} commit`);
  requireString(release.hash, `${name}@${version} hash`);
  requireString(release.description, `${name}@${version} description`);

  // An approved direct publish may only extend a pack THIS merge created. Matching on the flat
  // name alone let a third-party publish append a release inside a same-named first-party pack —
  // becoming `latest` while still advertising the first-party source.
  const pack = ctx.directPacks.get(name);
  const newKey = `direct--${flattenName(name)}`;
  let shadowedBase: { pack: RuntimePack; claim: PackNameClaim } | undefined;

  if (!pack) {
    // No direct pack yet, so this entry wants to create `newKey`. It must not collide with any
    // pre-existing identity, by name OR by flattened pack_key. TWO hazards, deliberately resolved
    // differently:
    //
    // (1) SAME NAME as a base (ingested) pack. Keeping the base pack here is CONTENT SUBSTITUTION
    //     under a name a third party proved control of: pinned clients following that name get the
    //     upstream source's bits, and the claim holder's approved release is dropped. So when this
    //     release comes from the repo the name's claim is pinned to, the CLAIM HOLDER wins and the
    //     base pack is dropped from the served catalog (reported, never silently). With no claim,
    //     or a claim pinned to another repo, the base pack stands and this entry is refused —
    //     exactly as before, and the only outcome the approve-time dry run can reach for a NEW
    //     name, since a bare name with no claim is refused earlier by the namespace gate (H1a).
    //
    // (2) SAME flattened pack_key as a DIFFERENT base pack (`a/b` vs `a--b`; only reachable when a
    //     base pack claims registry "direct"). pack_key keys reviews and ownership, so two packs
    //     under one key silently pool two identities. NEVER resolved by claim precedence: a claim
    //     on `a/b` proves nothing about the different name `a--b`, and dropping that pack would
    //     evict a name clients pin. Checked independently of (1) — not as its `else` — because
    //     dropping the same-NAMED pack would not free a key held by some other pack.
    const sameName = ctx.baseByName.get(name);
    const sameKey = ctx.basePackKeys.get(newKey);
    if (sameName) {
      const claim = heldNameClaim(ctx.nameClaims?.get(name), ctx.request);
      if (!claim) {
        throw new Error(
          `approved publish ${name} collides with base pack ${sameName.name} from source ${sameName.registry}`,
        );
      }
      shadowedBase = { pack: sameName, claim };
    }
    if (sameKey && sameKey !== sameName) {
      throw new Error(
        `approved publish ${name} collides with base pack ${sameKey.name} from source ${sameKey.registry}`,
      );
    }
    const twin = [...ctx.directPacks.values()].find((candidate) => packKeyFor(candidate) === newKey);
    if (twin) {
      throw new Error(
        `approved publish ${name} collides with ${twin.name}: both resolve to pack_key ${newKey}`,
      );
    }
  }

  const existingRelease = pack?.releases.find((candidate) => candidate.version === version);
  if (existingRelease) {
    if (
      existingRelease.commit === release.commit &&
      existingRelease.hash === release.hash &&
      existingRelease.ref === release.ref
    ) {
      return;
    }
    throw new Error(`approved publish conflicts with existing ${name} ${version}`);
  }
  // Validation passed — only now mutate.
  if (shadowedBase) {
    // Drop the ingested pack that held this name. Both base maps are updated so the name and its
    // pack_key stop existing as pre-existing identities — after this the name behaves exactly as it
    // would have if the upstream source had never declared it, which is the whole intent, and is
    // why this introduces no merge shape that an unclaimed-by-upstream name does not already have.
    packs.splice(packs.indexOf(shadowedBase.pack), 1);
    ctx.baseByName.delete(shadowedBase.pack.name);
    ctx.basePackKeys.delete(packKeyFor(shadowedBase.pack));
  }
  const target =
    pack ??
    (() => {
      const created: RuntimePack = {
        registry: "direct",
        name,
        description: entry.description,
        source: entry.source,
        sourceKind: entry.sourceKind,
        ogImage: "/og/registry.svg",
        releases: [],
      };
      packs.push(created);
      ctx.directPacks.set(name, created);
      return created;
    })();
  target.releases.push({ ...release });
  return shadowedBase
    ? {
        name: shadowedBase.pack.name,
        baseRegistry: shadowedBase.pack.registry,
        claimedBy: shadowedBase.claim.repoFullName,
      }
    : undefined;
}

// Re-derive one base source's `pack_count` from the packs actually being served. The generator
// computes it the same way (summarizeSources in scripts/generate-registry.lib.ts), so for an
// untouched base artifact this is byte-identical to the value it carried — but a pack that claim
// precedence dropped from a source must not still be counted in it. Anything that is not a
// {name: string, pack_count: number} object is passed through untouched rather than guessed at.
function withServedPackCount(source: unknown, packs: RuntimePack[]) {
  if (!source || typeof source !== "object") return source;
  const record = source as { name?: unknown; pack_count?: unknown };
  if (typeof record.name !== "string" || typeof record.pack_count !== "number") return source;
  const name = record.name;
  return { ...record, pack_count: packs.filter((pack) => pack.registry === name).length };
}

// Keyed by the name being SERVED (entry.name), not by the row's requestedName — the question this
// answers is who controls the name a client would resolve, and the two are only ever equal because
// nothing re-writes an entry's name. A row whose two names disagree therefore has to prove control
// of the served one, which is the conservative reading.
//
// The name's claim, but only when THIS approved request is the repo the pin names — otherwise
// undefined, which keeps the base pack. Same predicate as the approve-time merge gate and the
// approve transaction (server/publish.ts), so the three cannot drift into disagreeing about who
// holds a name. Fails closed on a row that cannot answer the pin at all: nameClaimMatchesRequest
// dereferences `repository`, and a row missing it must not become a TypeError that a strict-mode
// caller (the approve dry run) turns into a 409 on an unrelated publish.
function heldNameClaim(claim: PackNameClaim | undefined, request: PublishRequestRow) {
  if (!claim) return undefined;
  if (!request?.repository?.fullName || !request.repository.owner) return undefined;
  return nameClaimMatchesRequest(claim, request) ? claim : undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function readTomlPacks(baseToml: string): RuntimePack[] {
  const raw = parse(baseToml) as RawTomlCatalog;
  const rawPacks = Array.isArray(raw.pack) ? raw.pack : [];
  return rawPacks.map((pack) => normalizeTomlPack(pack as RawTomlPack));
}

function normalizeTomlPack(raw: RawTomlPack): RuntimePack {
  const name = requireString(raw.name, "pack.name");
  return {
    registry: "gascity-packs",
    name,
    description: requireString(raw.description, `${name}.description`),
    source: requireString(raw.source, `${name}.source`),
    sourceKind: requireString(raw.source_kind, `${name}.source_kind`),
    releases: (Array.isArray(raw.release) ? raw.release : []).map((release) =>
      normalizeTomlRelease(name, release as RawTomlRelease),
    ),
  };
}

function normalizeTomlRelease(packName: string, raw: RawTomlRelease): RuntimeRelease {
  const version = requireString(raw.version, `${packName}.release.version`);
  return {
    version,
    ref: requireString(raw.ref, `${packName}@${version}.ref`),
    commit: requireString(raw.commit, `${packName}@${version}.commit`),
    hash: requireString(raw.hash, `${packName}@${version}.hash`),
    description: requireString(raw.description, `${packName}@${version}.description`),
    withdrawn: raw.withdrawn === true,
    withdrawnReason: typeof raw.withdrawn_reason === "string" ? raw.withdrawn_reason : undefined,
  };
}

function readJsonPacks(raw: RawJsonCatalog): RuntimePack[] {
  const rawPacks = Array.isArray(raw.packs) ? raw.packs : [];
  return rawPacks.map((pack) => normalizeJsonPack(pack as RawJsonPack));
}

function normalizeJsonPack(raw: RawJsonPack): RuntimePack {
  const name = requireString(raw.name, "pack.name");
  return {
    registry: stringValue(raw.registry) ?? "aggregate",
    name,
    description: requireString(raw.description, `${name}.description`),
    source: requireString(raw.source, `${name}.source`),
    sourceKind: requireString(raw.source_kind, `${name}.source_kind`),
    readme: raw.readme,
    ogImage: stringValue(raw.og_image),
    releases: (Array.isArray(raw.releases) ? raw.releases : []).map((release) =>
      normalizeJsonRelease(name, release as RawTomlRelease),
    ),
  };
}

function normalizeJsonRelease(packName: string, raw: RawTomlRelease): RuntimeRelease {
  return normalizeTomlRelease(packName, raw);
}

function renderRegistryToml(packs: RuntimePack[]) {
  const lines = ["schema = 1", ""];
  for (const pack of packs) {
    lines.push("[[pack]]");
    lines.push(`  name = ${quote(pack.name)}`);
    lines.push(`  description = ${quote(pack.description)}`);
    lines.push(`  source = ${quote(pack.source)}`);
    lines.push(`  source_kind = ${quote(pack.sourceKind)}`);
    lines.push("");
    for (const release of pack.releases) {
      lines.push("  [[pack.release]]");
      lines.push(`    version = ${quote(release.version)}`);
      lines.push(`    ref = ${quote(release.ref)}`);
      lines.push(`    commit = ${quote(release.commit)}`);
      lines.push(`    hash = ${quote(release.hash)}`);
      lines.push(`    description = ${quote(release.description)}`);
      if (release.withdrawn) {
        lines.push("    withdrawn = true");
        if (release.withdrawnReason) {
          lines.push(`    withdrawn_reason = ${quote(release.withdrawnReason)}`);
        }
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// The grammar every `gc` client enforces: packNameRE plus the 64-character segment cap in
// internal/packregistry/catalog.go. ValidateCatalog aborts on the FIRST offending name, so one
// approved publish outside this grammar hides the entire catalog — every first-party pack
// included — from every client. Re-checked here and not only at submit because approve never
// re-runs normalizePublishRequestInput: a row queued before the submit grammar tightened, or
// written by a backfill, would otherwise sail through every submit-path gate. Strict mode turns
// this into a 409 at approve (assertPublishRequestCanMerge); the serve path is fail-soft, so it
// drops the one offender instead of the catalog.
//
// Deliberately LOOSER than the submit grammar in server/publish.ts: this one must accept every
// name already served, including grandfathered `a--b` and trailing-dash names. Tightening it to
// match the submit grammar would evict an already-published pack.
const clientPackNamePattern = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/;
const maxClientPackNameSegment = 64;

function assertClientParseablePackName(name: string) {
  for (const segment of name.split("/")) {
    if (segment.length > maxClientPackNameSegment) {
      throw new Error(
        `approved entry name ${JSON.stringify(name)} has a segment longer than ${maxClientPackNameSegment} characters; registry clients reject the whole catalog on one bad name`,
      );
    }
  }
  if (!clientPackNamePattern.test(name)) {
    throw new Error(
      `approved entry name ${JSON.stringify(name)} is not a valid pack name; registry clients reject the whole catalog on one bad name`,
    );
  }
}

// A scoped name flattens with the same "/" -> "--" rule the generator and the SPA use
// (scripts/generate-registry.lib.ts, src/lib/registry.ts). Kept as one helper so the
// collision check and the emitted pack_key can never drift apart.
function flattenName(name: string) {
  return name.replaceAll("/", "--");
}

function packKeyFor(pack: RuntimePack) {
  return `${pack.registry}--${flattenName(pack.name)}`;
}

function catalogJsonPack(pack: RuntimePack) {
  const latest = latestActiveVersion(pack);
  return {
    pack_key: packKeyFor(pack),
    registry: pack.registry,
    name: pack.name,
    description: pack.description,
    source: pack.source,
    source_kind: pack.sourceKind,
    search_text: searchTextFor(pack),
    readme: pack.readme,
    og_image: pack.ogImage ?? "/og/registry.svg",
    latest,
    releases: pack.releases.map((release) => ({
      version: release.version,
      ref: release.ref,
      commit: release.commit,
      hash: release.hash,
      description: release.description,
      withdrawn: release.withdrawn === true,
      withdrawn_reason: release.withdrawnReason,
    })),
  };
}

function latestActiveVersion(pack: RuntimePack) {
  return pack.releases
    .filter((release) => !release.withdrawn)
    .sort((left, right) => -compareVersions(left.version, right.version))[0]?.version;
}

function searchTextFor(pack: RuntimePack) {
  return [
    pack.name,
    pack.registry,
    pack.description,
    pack.source,
    pack.sourceKind,
    ...pack.releases.map((release) => `${release.version} ${release.description}`),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function quote(value: string) {
  return JSON.stringify(value);
}
