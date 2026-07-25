// Pack-name semantics the SPA needs, deliberately dependency-free so it can run under plain
// `bun test` with no DOM and no Vite env. The server's copy lives in server/publish.ts —
// `tsconfig.app.json` includes only `src` and `tsconfig.server.json` only `server`, both
// `composite`, so the two projects cannot import from each other and the duplication is
// structural rather than sloppy. Both copies are pinned by identical expectation tables
// (src/lib/packName.test.ts and server/publish.test.ts).

// The scope segment of a pack name (`acme` of `acme/tools`); undefined for a bare name. Bare
// names are the reserved, ingested half of the namespace, which is why the withdraw UI has to be
// able to tell them apart: releasing a bare name's claim is refused server-side.
export function packNameScope(name: string) {
  const [scope, rest] = name.split("/");
  return rest ? scope : undefined;
}

// The name split into URL path segments — one per name segment, so `owner/pack` becomes a real
// two-segment path instead of a `%2F` that an intermediary can silently decode into a `/`.
export function packNameSegments(name: string) {
  return name.split("/");
}

// Why the staff "release the name claim" lever must not be offered on a row, or undefined when it
// may be. Advisory only: the server refuses both cases regardless (assertNameClaimReleasable and
// the survivor check inside the withdraw transaction). The point is not to enforce anything, it is
// to avoid offering staff a checkbox that always 422s.
//
// A pure function, on purpose. The bare-name branch is not reachable through any API — nothing can
// mint a bare name claim today, so no approved bare-named row can be created in a test harness —
// and a branch that no test can kill is a branch that silently rots.
export type NameClaimReleaseBlocker = "unscoped_name_reserved" | "sibling_release_served";

export function nameClaimReleaseBlocker(
  request: { id: string; requestedName: string },
  // The already-loaded review queue. A stale queue can only ever HIDE the checkbox from a release
  // the server would have allowed; it cannot manufacture one the server would refuse.
  queue: ReadonlyArray<{ id: string; requestedName: string; status: string }>,
): NameClaimReleaseBlocker | undefined {
  // Bare names are reserved. Releasing one does not return it to a usable pool, it makes the name
  // permanently unpublishable — so the server refuses outright.
  if (!packNameScope(request.requestedName)) return "unscoped_name_reserved";
  // Releasing while a sibling release is still served would leave a live, served name unclaimed,
  // and the next boot's grandfather backfill would silently re-mint the claim against the
  // first-approved repo.
  const survivor = queue.some(
    (other) =>
      other.id !== request.id &&
      other.requestedName === request.requestedName &&
      other.status === "approved",
  );
  return survivor ? "sibling_release_served" : undefined;
}
