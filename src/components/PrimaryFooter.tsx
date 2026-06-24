import type React from "react";
import { REGISTRY_SOURCE_URL } from "../lib/links";
import { withBase } from "../lib/base";

/**
 * The standalone site footer (the apex provides its own chrome, so this only
 * renders outside the cockpit). `role="contentinfo"` is explicit because the
 * footer lives inside <ShellFrame>'s <main>, where a bare <footer> would not map
 * to the contentinfo landmark.
 */
export function PrimaryFooter({ navigateTo }: { navigateTo: (path: string) => void }) {
  const go = (path: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    navigateTo(path);
  };

  return (
    <footer className="siteFooter" role="contentinfo">
      <div>
        <strong>Gas City Registry</strong>
        <span>The synthetic aggregate of verified packs.</span>
      </div>
      <nav className="footerNav" aria-label="Registry resources">
        <a href={REGISTRY_SOURCE_URL} target="_blank" rel="noreferrer">
          Source
        </a>
        <a href={withBase("/verify")} onClick={go("/verify")}>
          Verification flow
        </a>
        <a href={withBase("/publish")} onClick={go("/publish")}>
          Publish a pack
        </a>
      </nav>
    </footer>
  );
}
