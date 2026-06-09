import { AlertTriangle, Box, CheckCircle2, Loader2 } from "lucide-react";
import {
  categoryForPack,
  latestActiveRelease,
  shortCommit,
  type CatalogPack,
  type CatalogRelease,
} from "../lib/registry";
import type { RegistryCatalogState } from "../lib/registry";

export type CatalogStatus =
  | { state: "loading" }
  | { state: "ready"; catalog: RegistryCatalogState }
  | { state: "error"; message: string };

export function Metric({ value, label }: { value: number | string; label: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function PackIcon({ pack }: { pack: CatalogPack }) {
  const category = categoryForPack(pack);
  const Icon = category.icon;
  return (
    <span className="packIcon" aria-hidden="true">
      <Icon size={18} />
    </span>
  );
}

export function StatusBadge({ pack }: { pack: CatalogPack }) {
  const latest = latestActiveRelease(pack);
  if (!latest) {
    return (
      <span className="statusBadge warning">
        <AlertTriangle size={13} aria-hidden="true" />
        Withdrawn
      </span>
    );
  }
  return (
    <span className="statusBadge">
      <CheckCircle2 size={13} aria-hidden="true" />
      Active
    </span>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="emptyState">
      <Box size={24} aria-hidden="true" />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

export function CatalogLoadState({ catalogStatus }: { catalogStatus: CatalogStatus }) {
  if (catalogStatus.state === "loading") {
    return (
      <div className="inlineState">
        <Loader2 className="spin" size={18} aria-hidden="true" />
        <span>Reading Gas City registry catalog...</span>
      </div>
    );
  }
  if (catalogStatus.state === "error") {
    return (
      <div className="inlineState error">
        <AlertTriangle size={18} aria-hidden="true" />
        <span>{catalogStatus.message}</span>
      </div>
    );
  }
  return null;
}

export function ReleaseRow({ release }: { release: CatalogRelease }) {
  return (
    <article className={release.withdrawn ? "releaseRow withdrawn" : "releaseRow"}>
      <div>
        <strong>v{release.version}</strong>
        <span>{release.description}</span>
        {release.withdrawn && release.withdrawnReason ? (
          <em>Withdrawn: {release.withdrawnReason}</em>
        ) : null}
      </div>
      <div className="releaseFacts">
        <span>{release.ref}</span>
        <span>{shortCommit(release.commit)}</span>
        <code>{release.hash}</code>
      </div>
    </article>
  );
}

export function shortSource(source: string) {
  try {
    const url = new URL(source);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return source;
  }
}
