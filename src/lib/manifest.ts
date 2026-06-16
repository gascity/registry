import type { PanelEntry, ShellManifest } from "@gascity/shell";

/**
 * The registry product's panel manifest for <ShellFrame>. (B1: built locally
 * from the auth role; once the shell BFF exists this comes from GET
 * /shell/manifest, entitlement-filtered server-side.) Scopes use the live
 * scopes.go vocabulary; "Review" is gated to moderators/admins.
 */
export function registryManifest(role?: string): ShellManifest {
  const panels: PanelEntry[] = [
    { slug: "catalog", label: "Browse", href: "/", requiredScope: "registry:read" },
    { slug: "publish", label: "Publish", href: "/publish", requiredScope: "registry:read" },
  ];
  if (role === "admin" || role === "moderator") {
    panels.push({
      slug: "review",
      label: "Review",
      href: "/admin/publish-requests",
      requiredScope: "registry:moderate",
    });
  }
  return { product: "gascity-registry", panels };
}
