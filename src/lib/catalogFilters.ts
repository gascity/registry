import {
  categoryForPack,
  compareVersions,
  latestActiveRelease,
  type CatalogPack,
} from "./registry";
import type { SearchState } from "./urlState";

export function filterAndSortPacks(packs: CatalogPack[], searchState: SearchState) {
  const normalizedQuery = searchState.query.trim().toLowerCase();
  const filtered = packs.filter((pack) => {
    const latest = latestActiveRelease(pack);
    if (!searchState.includeWithdrawn && !latest) return false;
    if (searchState.category !== "all" && categoryForPack(pack).value !== searchState.category) {
      return false;
    }
    if (!normalizedQuery) return true;
    const searchText =
      pack.searchText ||
      [
        pack.name,
        pack.registry,
        pack.description,
        pack.source,
        categoryForPack(pack).label,
        pack.readme?.content ?? "",
        ...pack.releases.map((release) => `${release.version} ${release.description}`),
      ]
        .join(" ")
        .toLowerCase();
    return searchText.includes(normalizedQuery);
  });

  return filtered.sort((a, b) => {
    if (searchState.sort === "name") return a.name.localeCompare(b.name);
    if (searchState.sort === "latest") {
      return compareVersions(
        latestActiveRelease(b)?.version ?? "0.0.0",
        latestActiveRelease(a)?.version ?? "0.0.0",
      );
    }
    if (searchState.sort === "releases") return b.releases.length - a.releases.length;
    const left = latestActiveRelease(a) ? 0 : 1;
    const right = latestActiveRelease(b) ? 0 : 1;
    return left - right || a.name.localeCompare(b.name);
  });
}
