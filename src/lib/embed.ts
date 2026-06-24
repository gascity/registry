/**
 * True when registry is running inside the apex cockpit (a same-origin iframe
 * "Space"), false when it is the standalone site. The apex owns the outer chrome
 * (top strip + rail), so when embedded we render only registry's window — a
 * <ProductShell> sub-nav — instead of our own full <ShellFrame> cockpit, which
 * would nest a second cockpit inside the apex.
 *
 * Mirrors @gascity/panel-sdk's own iframe check (window.parent === window).
 */
export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent throws on access — which only happens when framed.
    return true;
  }
}
