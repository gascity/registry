import type { PanelEntry, ShellManifest, SubNavItem } from "@gascity/shell";

/**
 * The registry product's panel manifest for <ShellFrame>. (B1: built locally
 * from the auth role; once the shell BFF exists this comes from GET
 * /shell/manifest, entitlement-filtered server-side.) Scopes use the live
 * scopes.go vocabulary; "Review" is gated to moderators/admins.
 */
export function registryManifest(role?: string): ShellManifest {
  // `mount` is required on the wire (the apex uses it to load a product), but is
  // unused here: standalone, registry IS the app and navigates these sections via
  // onNavigate, never mounting them. The embedded path uses registrySubNav() instead.
  const mount = "iframe";
  const panels: PanelEntry[] = [
    { slug: "catalog", label: "Browse", href: "/", requiredScope: "registry:read", mount },
    { slug: "publish", label: "Publish", href: "/publish", requiredScope: "registry:read", mount },
  ];
  if (role === "admin" || role === "moderator") {
    panels.push({
      slug: "review",
      label: "Review",
      href: "/admin/publish-requests",
      requiredScope: "registry:moderate",
      mount,
    });
  }
  return { product: "gascity-registry", panels };
}

/**
 * The same sections as a product sub-nav, for when registry renders embedded in
 * the apex (a <ProductShell>'s <ProductNav>) rather than as its own cockpit.
 */
export function registrySubNav(role?: string): SubNavItem[] {
  const items: SubNavItem[] = [
    { slug: "catalog", label: "Browse", href: "/" },
    { slug: "publish", label: "Publish", href: "/publish" },
  ];
  if (role === "admin" || role === "moderator") {
    items.push({ slug: "review", label: "Review", href: "/admin/publish-requests" });
  }
  return items;
}
