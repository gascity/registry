import { Box } from "lucide-react";
import {
  EmptyState as UIEmptyState,
  ErrorState,
  Spinner,
  StatTile,
  StatusBadge as UIStatusBadge,
  Text,
  type StateStatusMap,
} from "@gascity/ui";
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

/** Pack release state → Badge status. Active releases read success; a pack with
 *  no active release (everything withdrawn) reads warn. */
const StateStatusMap: StateStatusMap = { active: "success", withdrawn: "warn" };

export function Metric({ value, label }: { value: number | string; label: string }) {
  return <StatTile label={label} value={value} />;
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
  const state = latestActiveRelease(pack) ? "active" : "withdrawn";
  return (
    <UIStatusBadge state={state} map={StateStatusMap}>
      {state === "active" ? "Active" : "Withdrawn"}
    </UIStatusBadge>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <UIEmptyState
      icon={<Box size={24} aria-hidden="true" />}
      title={title}
      description={description}
    />
  );
}

export function CatalogLoadState({ catalogStatus }: { catalogStatus: CatalogStatus }) {
  if (catalogStatus.state === "loading") {
    return (
      <div className="inlineState">
        <Spinner size="sm" label={null} />
        <Text as="span" tone="muted">Reading Gas City registry catalog...</Text>
      </div>
    );
  }
  if (catalogStatus.state === "error") {
    return (
      <ErrorState compact title="Couldn’t load the catalog" message={catalogStatus.message} />
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
