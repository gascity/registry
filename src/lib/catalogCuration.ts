import { compareByCodepoint, UNKNOWN_PUBLISHER } from "../../shared/catalogPolicy";
import { latestActiveRelease, type CatalogPack } from "./registry";

function isFeaturedEligible(pack: CatalogPack) {
  return Boolean(
    latestActiveRelease(pack) &&
      pack.publisher.trim() &&
      pack.publisher !== UNKNOWN_PUBLISHER,
  );
}

export function selectFeaturedPacks(
  packs: CatalogPack[],
  featuredPackKeys: string[],
) {
  const byKey = new Map(packs.map((pack) => [pack.packKey, pack]));
  const selected: CatalogPack[] = [];
  const seen = new Set<string>();
  for (const key of featuredPackKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const pack = byKey.get(key);
    if (pack && isFeaturedEligible(pack)) selected.push(pack);
  }
  return selected;
}

export function compareFeaturedPacks(
  left: CatalogPack,
  right: CatalogPack,
  featuredPackKeys: string[],
) {
  const ranks = new Map(featuredPackKeys.map((key, index) => [key, index]));
  const leftActive = Boolean(latestActiveRelease(left));
  const rightActive = Boolean(latestActiveRelease(right));
  if (leftActive !== rightActive) return leftActive ? -1 : 1;

  if (leftActive && rightActive) {
    const leftRank = isFeaturedEligible(left) ? ranks.get(left.packKey) : undefined;
    const rightRank = isFeaturedEligible(right) ? ranks.get(right.packKey) : undefined;
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
  }
  return compareByCodepoint(left.name, right.name);
}
