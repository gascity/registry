import { stripBase, withBase } from "./base";
import { packNameSegments } from "./packName";

export type SortKey = "featured" | "name" | "latest" | "releases";
export type ViewMode = "list" | "grid";
export type RouteState =
  | { kind: "home" }
  | { kind: "pack"; name: string }
  | { kind: "account" }
  | { kind: "adminPublish" }
  | { kind: "verify" }
  | { kind: "publish" }
  | { kind: "cliAuth" }
  | { kind: "cliDevice" };

export const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: "featured", label: "Featured" },
  { value: "name", label: "Name" },
  { value: "latest", label: "Latest version" },
  { value: "releases", label: "Release count" },
];

export const categoryOptions = [
  { value: "workflow", label: "Workflows" },
  { value: "chatops", label: "ChatOps" },
  { value: "integration", label: "Integrations" },
  { value: "knowledge", label: "Knowledge" },
];

export function parseRoute(rawPathname: string): RouteState {
  // Routes are matched logically (root-relative); strip the apex /registry mount.
  const pathname = stripBase(rawPathname);
  if (pathname === "/account" || pathname === "/account/") return { kind: "account" };
  if (pathname === "/admin/publish-requests" || pathname === "/admin/publish-requests/") {
    return { kind: "adminPublish" };
  }
  if (pathname === "/verify" || pathname === "/verify/") return { kind: "verify" };
  if (pathname === "/publish" || pathname === "/publish/") return { kind: "publish" };
  if (pathname === "/cli/auth" || pathname === "/cli/auth/") return { kind: "cliAuth" };
  if (pathname === "/cli/device" || pathname === "/cli/device/") return { kind: "cliDevice" };
  // One or two REAL path segments, so a scoped `owner/pack` is `/packs/owner/pack`. The old
  // single-segment `%2F` form still parses (the first branch decodes it), which is what keeps
  // already-shared scoped links alive. Deeper paths and a bare `/packs/` fall through to home,
  // exactly as before — the matcher stays anchored rather than becoming a greedy `(.+)`.
  const match = pathname.match(/^\/packs\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!match?.[1]) return { kind: "home" };
  const segments = [match[1], match[2]].filter((segment): segment is string => segment !== undefined);
  return { kind: "pack", name: segments.map(decodeURIComponent).join("/") };
}

export function readSearchState(search: string) {
  const params = new URLSearchParams(search);
  const category = params.get("category");
  const sort = params.get("sort");
  const view = params.get("view");
  const author = params.get("author");
  return {
    query: params.get("q") ?? "",
    category: categoryOptions.some((option) => option.value === category) ? (category as string) : "all",
    // Constrain to the GitHub owner shape (like category/sort against their allowlists):
    // derived authors are GitHub owners, so anything else is a crafted value that would
    // otherwise reach document.title / og tags / the filter chip — reject it to "".
    author: /^[A-Za-z0-9-]{1,39}$/.test(author ?? "") ? (author as string) : "",
    includeWithdrawn: params.get("withdrawn") === "true",
    sort: sortOptions.some((option) => option.value === sort) ? (sort as SortKey) : "featured",
    view: view === "grid" ? "grid" : ("list" as ViewMode),
  };
}

export type SearchState = ReturnType<typeof readSearchState>;

export function buildSearchString({
  query,
  category,
  author,
  includeWithdrawn,
  sort,
  view,
}: SearchState) {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (category !== "all") params.set("category", category);
  if (author.trim()) params.set("author", author.trim());
  if (includeWithdrawn) params.set("withdrawn", "true");
  if (sort !== "featured") params.set("sort", sort);
  if (view === "grid") params.set("view", "grid");
  const next = params.toString();
  return next ? `?${next}` : "";
}

/** True when the query or author filter narrows the catalog — the homepage collapses
 *  the sections above the results (stats, featured, CLI endpoint) only in this mode.
 *  Query and author only: category and withdrawn are driven by controls that live INSIDE
 *  the browse section, so collapsing ~600px above them would yank the page mid-interaction
 *  (Safari has no scroll anchoring); sort and view are pure presentation of the full
 *  catalog. Author is never set from a control inside the browse section — it arrives only
 *  from the pack-detail "by {owner}" link or a deep link — so collapsing to it is safe and
 *  lands the author's packs directly under the search bar. Whitespace-only is not narrowing,
 *  consistent with buildSearchString (omits the key) and filterAndSortPacks (no-op filter). */
export function hasActiveSearch({ query, author }: SearchState): boolean {
  return query.trim() !== "" || author.trim() !== "";
}

export function updateUrl(pathname: string, search: string, replace = false) {
  // Logical paths in; write the real (mount-prefixed) URL to history.
  const next = `${withBase(pathname)}${search}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === next) return;
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
}

// The one place a pack URL is built (navigatePack, PackLink's href, App's canonicalization all
// route through here). One path segment per name segment: `%2F` is not safe end to end, because a
// prefix-stripping proxy that rewrites the decoded path without keeping the raw path in sync turns
// the escape back into a real separator — and the single-segment SPA matcher then read
// `/packs/owner/pack` as HOME, serving a silently wrong page rather than a 404.
export function packPath(name: string) {
  return `/packs/${packNameSegments(name).map(encodeURIComponent).join("/")}`;
}
