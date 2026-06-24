// The mount prefix this build is served under, derived from Vite's build-time
// `base` (REGISTRY_WEB_BASE). Single source of truth for the prefix.
//
//   standalone build (base "/")        -> MOUNT_BASE = ""        withBase("/api/x") = "/api/x"
//   apex-panel build (base "/registry/") -> MOUNT_BASE = "/registry" withBase("/api/x") = "/registry/api/x"
//
// This mirrors @gascity/app-kit's createMountBase, inlined here so registry
// doesn't have to take app-kit's react-router-dom peer dep (it keeps its own
// hand-rolled router). The apex edge strips the /registry prefix before the bun
// server, so prefixed client paths round-trip to the server's root routes.

const MOUNT_BASE: string = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");

export { MOUNT_BASE };

/** Prefix an app-absolute path with the mount base for fetches / hrefs / history. */
export function withBase(path: string): string {
  return MOUNT_BASE + path;
}

/** Strip the mount base off a browser path so logical (root-relative) route matching works.
 *  Boundary-aware: "/registry" and "/registry/x" strip; "/registryfoo" is left untouched. */
export function stripBase(path: string): string {
  if (MOUNT_BASE && (path === MOUNT_BASE || path.startsWith(`${MOUNT_BASE}/`))) {
    return path.slice(MOUNT_BASE.length) || "/";
  }
  return path;
}
