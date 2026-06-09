import { RequestError } from "./http";

type CatalogPackRecord = {
  pack_key?: unknown;
  name?: unknown;
  source?: unknown;
};

type CatalogRecord = {
  packs?: unknown;
};

const distCatalogUrl = new URL("../dist/catalog.json", import.meta.url);
const publicCatalogUrl = new URL("../public/catalog.json", import.meta.url);

export type CatalogPackSource = {
  packKey: string;
  name: string;
  source: string;
};

export async function requireCatalogPackSource(
  packKey: string,
  sourceUrl: string,
): Promise<CatalogPackSource> {
  const pack = (await readCatalogPacks()).find((candidate) => candidate.packKey === packKey);
  if (!pack || pack.source !== sourceUrl) {
    throw new RequestError(422, "VALIDATION_ERROR", "Pack source does not match the catalog.");
  }
  return pack;
}

async function readCatalogPacks() {
  const raw = JSON.parse(await readCatalogText()) as CatalogRecord;
  const packs = Array.isArray(raw.packs) ? raw.packs : [];
  return packs.map(normalizePack).filter((pack): pack is CatalogPackSource => Boolean(pack));
}

async function readCatalogText() {
  const distFile = Bun.file(distCatalogUrl);
  if (await distFile.exists()) return distFile.text();
  return Bun.file(publicCatalogUrl).text();
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
