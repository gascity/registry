// The GitHub owner segment of a pack's source URL — the only author signal present for
// every pack in the catalog. Display-honest: this is "who owns the source repo", not a
// verified publisher identity (that lives behind GET /api/ownership on the Trust tab).
// Dependency-free (like packName.ts) so it runs under plain `bun test`.
export function packAuthor(source: string): string | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return undefined;
  const [owner] = url.pathname.split("/").filter(Boolean);
  if (!owner) return undefined;
  try {
    return decodeURIComponent(owner);
  } catch {
    return undefined;
  }
}
