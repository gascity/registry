type CatalogPackRecord = {
  pack_key?: unknown;
  name?: unknown;
  source?: unknown;
};

export type CatalogPackSource = {
  packKey: string;
  name: string;
  source: string;
};

// Look one pack_key up in a catalog artifact the CALLER read. No filesystem access on purpose:
// the module constants this replaced pointed at ../dist and ../public directly and ignored the
// request handler's injected distRoot, so what the ownership routes saw depended on whether
// `bun run build` had ever run and no test could control it.
//
// A corrupt artifact returns null rather than throwing: this feeds two public reads, and a parse
// error must not 500 them. It fails CLOSED for verification — with no base pack found the caller
// falls through to the name-claim branch, which only ever answers for a `direct--` key, and no
// generated base pack has one.
export function findCatalogPackSource(catalogJson: string, packKey: string): CatalogPackSource | null {
  let raw: unknown;
  try {
    raw = JSON.parse(catalogJson);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const packs = Array.isArray((raw as { packs?: unknown }).packs)
    ? ((raw as { packs: unknown[] }).packs)
    : [];
  for (const candidate of packs) {
    const pack = normalizePack(candidate);
    if (pack && pack.packKey === packKey) return pack;
  }
  return null;
}

function normalizePack(raw: unknown): CatalogPackSource | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as CatalogPackRecord;
  const packKey = stringValue(record.pack_key);
  const name = stringValue(record.name);
  const source = stringValue(record.source);
  if (!packKey || !name || !source) return null;
  return { packKey, name, source };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
