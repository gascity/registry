export type SortKey = "featured" | "name" | "latest" | "releases";
export type ViewMode = "list" | "grid";
export type RouteState = { kind: "home" } | { kind: "pack"; name: string } | { kind: "account" };

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

export function parseRoute(pathname: string): RouteState {
  if (pathname === "/account" || pathname === "/account/") return { kind: "account" };
  const match = pathname.match(/^\/packs\/([^/]+)\/?$/);
  if (!match) return { kind: "home" };
  return { kind: "pack", name: decodeURIComponent(match[1]) };
}

export function readSearchState(search: string) {
  const params = new URLSearchParams(search);
  const sort = params.get("sort");
  const view = params.get("view");
  return {
    query: params.get("q") ?? "",
    category: params.get("category") ?? "all",
    includeWithdrawn: params.get("withdrawn") === "true",
    sort: sortOptions.some((option) => option.value === sort) ? (sort as SortKey) : "featured",
    view: view === "grid" ? "grid" : ("list" as ViewMode),
  };
}

export type SearchState = ReturnType<typeof readSearchState>;

export function buildSearchString({
  query,
  category,
  includeWithdrawn,
  sort,
  view,
}: SearchState) {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (category !== "all") params.set("category", category);
  if (includeWithdrawn) params.set("withdrawn", "true");
  if (sort !== "featured") params.set("sort", sort);
  if (view === "grid") params.set("view", "grid");
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function updateUrl(pathname: string, search: string, replace = false) {
  const next = `${pathname}${search}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === next) return;
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
}

export function packPath(name: string) {
  return `/packs/${encodeURIComponent(name)}`;
}
