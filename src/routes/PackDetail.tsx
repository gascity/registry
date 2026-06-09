import {
  ArrowDownToLine,
  BookOpen,
  Copy,
  ExternalLink,
  FileCode2,
  GitBranch,
  ShieldCheck,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "../components/CopyButton";
import { ReviewPanel } from "../components/ReviewPanel";
import {
  CatalogLoadState,
  EmptyState,
  PackIcon,
  ReleaseRow,
  shortSource,
  StatusBadge,
  type CatalogStatus,
} from "../components/RegistryPrimitives";
import type { AuthState } from "../lib/api";
import {
  buildImportCommands,
  categoryForPack,
  compareVersions,
  latestActiveRelease,
  type CatalogPack,
  type CatalogRelease,
} from "../lib/registry";

type DetailTabId = "readme" | "install" | "releases" | "metadata" | "source" | "trust";

type DetailTab = {
  id: DetailTabId;
  label: string;
  icon: React.ReactNode;
};

export function PackDetail({
  catalogStatus,
  pack,
  requestedName,
  auth,
  signIn,
  devSignIn,
  onBack,
}: {
  catalogStatus: CatalogStatus;
  pack: CatalogPack | undefined;
  requestedName: string;
  auth: AuthState;
  signIn: () => void;
  devSignIn: () => void;
  onBack: () => void;
}) {
  const [reviewSummary, setReviewSummary] = useState<{
    count: number;
    averageRating: number | null;
    recommendCount: number;
  } | null>(null);

  if (catalogStatus.state !== "ready") {
    return (
      <main className="detailPage">
        <button className="backButton" type="button" onClick={onBack}>
          Browse packs
        </button>
        <CatalogLoadState catalogStatus={catalogStatus} />
      </main>
    );
  }

  if (!pack) {
    return (
      <main className="detailPage">
        <button className="backButton" type="button" onClick={onBack}>
          Browse packs
        </button>
        <EmptyState
          title={`Pack "${requestedName}" was not found`}
          body="The catalog loaded successfully, but this pack name is not present."
        />
      </main>
    );
  }

  const latest = latestActiveRelease(pack);
  const sortedReleases = [...pack.releases].sort((a, b) => -compareVersions(a.version, b.version));
  const activeReleases = pack.releases.filter((release) => !release.withdrawn).length;
  const commands = latest ? buildImportCommands(pack, latest.version) : null;

  return (
    <main className="detailPage">
      <button className="backButton" type="button" onClick={onBack}>
        Browse packs
      </button>

      <section className="detailHero">
        <div>
          <div className="detailKicker">
            <PackIcon pack={pack} />
            <span>{categoryForPack(pack).label}</span>
            <StatusBadge pack={pack} />
          </div>
          <h1>{pack.name}</h1>
          <p>{pack.description}</p>
        </div>
        <aside className="detailSnapshot" aria-label="Pack summary">
          <dl className="metadataList">
            <div>
              <dt>Registry</dt>
              <dd>{pack.registry}</dd>
            </div>
            <div>
              <dt>Latest</dt>
              <dd>{latest ? `v${latest.version}` : "None"}</dd>
            </div>
            <div>
              <dt>Active releases</dt>
              <dd>{activeReleases}</dd>
            </div>
            <div>
              <dt>Reviews</dt>
              <dd>
                {reviewSummary?.count
                  ? `${reviewSummary.averageRating}/5 from ${reviewSummary.count}`
                  : "None yet"}
              </dd>
            </div>
          </dl>
        </aside>
      </section>

      {commands ? (
        <section className="installCallout" aria-label="Primary install command">
          <div>
            <p className="eyebrow">Install</p>
            <code>{commands.floating}</code>
          </div>
          <CopyButton text={commands.floating} ariaLabel="Copy primary install command" />
        </section>
      ) : null}

      <PackDetailTabs pack={pack} latest={latest} sortedReleases={sortedReleases} />
      <ReviewPanel
        pack={pack}
        auth={auth}
        signIn={signIn}
        devSignIn={devSignIn}
        onReviewSummary={setReviewSummary}
      />
    </main>
  );
}

function PackDetailTabs({
  pack,
  latest,
  sortedReleases,
}: {
  pack: CatalogPack;
  latest: CatalogRelease | undefined;
  sortedReleases: CatalogRelease[];
}) {
  const defaultTab = pack.readme ? "readme" : "install";
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs = useMemo(
    () =>
      [
        pack.readme ? { id: "readme", label: "README", icon: <BookOpen size={16} /> } : null,
        { id: "install", label: "Install", icon: <Copy size={16} /> },
        { id: "releases", label: "Releases", icon: <ArrowDownToLine size={16} /> },
        { id: "metadata", label: "Metadata", icon: <FileCode2 size={16} /> },
        { id: "source", label: "Source", icon: <GitBranch size={16} /> },
        { id: "trust", label: "Trust", icon: <ShieldCheck size={16} /> },
      ].filter(Boolean) as DetailTab[],
    [pack.readme],
  );
  const [activeTab, setActiveTab] = useState<DetailTabId>(() =>
    readDetailTabFromHash(tabs, defaultTab),
  );

  useEffect(() => {
    const syncHash = () => setActiveTab(readDetailTabFromHash(tabs, defaultTab));
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [defaultTab, pack.name, tabs]);

  const selectTab = (tab: DetailTabId) => {
    setActiveTab(tab);
    const hash = tab === defaultTab ? "" : `#${tab}`;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${hash}`,
    );
  };

  const focusTab = (index: number) => {
    const bounded = (index + tabs.length) % tabs.length;
    const next = tabs[bounded];
    if (!next) return;
    selectTab(next.id);
    tabRefs.current[bounded]?.focus();
  };

  return (
    <section className="tabCard" aria-label="Pack details">
      <div className="tabHeader" role="tablist" aria-label={`${pack.name} detail tabs`}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            className={activeTab === tab.id ? "tabButton active" : "tabButton"}
            type="button"
            role="tab"
            tabIndex={activeTab === tab.id ? 0 : -1}
            aria-selected={activeTab === tab.id}
            aria-controls={`pack-tabpanel-${tab.id}`}
            id={`pack-tab-${tab.id}`}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                focusTab(index + 1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                focusTab(index - 1);
              } else if (event.key === "Home") {
                event.preventDefault();
                focusTab(0);
              } else if (event.key === "End") {
                event.preventDefault();
                focusTab(tabs.length - 1);
              }
            }}
          >
            <span aria-hidden="true">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      <div
        className="tabBody"
        role="tabpanel"
        id={`pack-tabpanel-${activeTab}`}
        aria-labelledby={`pack-tab-${activeTab}`}
      >
        {activeTab === "readme" ? <ReadmeTab pack={pack} /> : null}
        {activeTab === "install" ? <InstallTab pack={pack} latest={latest} /> : null}
        {activeTab === "releases" ? <ReleasesTab releases={sortedReleases} /> : null}
        {activeTab === "metadata" ? <MetadataTab pack={pack} latest={latest} /> : null}
        {activeTab === "source" ? <SourceTab pack={pack} /> : null}
        {activeTab === "trust" ? <TrustTab /> : null}
      </div>
    </section>
  );
}

function readDetailTabFromHash(tabs: DetailTab[], defaultTab: DetailTabId) {
  const hash = window.location.hash.replace(/^#/, "") as DetailTabId;
  return tabs.some((tab) => tab.id === hash) ? hash : defaultTab;
}

function ReadmeTab({ pack }: { pack: CatalogPack }) {
  if (!pack.readme) {
    return (
      <EmptyState
        title="No README found"
        body="The aggregate catalog did not find a README for this pack."
      />
    );
  }

  return (
    <article className="markdownPanel">
      <div className="readmeToolbar">
        <span>Source README</span>
        <a href={pack.readme.url} rel="noreferrer">
          <ExternalLink size={15} aria-hidden="true" />
          Raw
        </a>
      </div>
      <div className="markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a({ href, children }) {
              const resolvedHref = resolveReadmeHref(pack, href, "link");
              return (
                <a href={resolvedHref} rel="noreferrer">
                  {children}
                </a>
              );
            },
            img({ src, alt }) {
              const resolvedSrc = resolveReadmeHref(pack, src, "image");
              return <img src={resolvedSrc} alt={alt ?? ""} loading="lazy" />;
            },
          }}
        >
          {pack.readme.content}
        </ReactMarkdown>
      </div>
    </article>
  );
}

function InstallTab({ pack, latest }: { pack: CatalogPack; latest: CatalogRelease | undefined }) {
  const commands = latest ? buildImportCommands(pack, latest.version) : null;
  return commands ? (
    <div className="installCommands">
      <CommandBlock label="This version or later" command={commands.floating} />
      <CommandBlock label="Exactly this version" command={commands.exact} />
    </div>
  ) : (
    <p className="mutedText">This pack has no active release to import.</p>
  );
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  return (
    <div className="commandBlock">
      <span>{label}</span>
      <code>{command}</code>
      <CopyButton text={command} ariaLabel={`Copy ${label} command`} />
    </div>
  );
}

function ReleasesTab({ releases }: { releases: CatalogRelease[] }) {
  return (
    <div className="releaseTable">
      {releases.map((release) => (
        <ReleaseRow key={`${release.version}-${release.commit}`} release={release} />
      ))}
    </div>
  );
}

function MetadataTab({ pack, latest }: { pack: CatalogPack; latest: CatalogRelease | undefined }) {
  const activeReleases = pack.releases.filter((release) => !release.withdrawn).length;
  return (
    <dl className="metadataList metadataListWide">
      <div>
        <dt>Registry</dt>
        <dd>{pack.registry}</dd>
      </div>
      <div>
        <dt>Source kind</dt>
        <dd>{pack.sourceKind}</dd>
      </div>
      <div>
        <dt>Latest</dt>
        <dd>{latest ? `v${latest.version}` : "None"}</dd>
      </div>
      <div>
        <dt>Active releases</dt>
        <dd>{activeReleases}</dd>
      </div>
      <div>
        <dt>Withdrawn releases</dt>
        <dd>{pack.releases.length - activeReleases}</dd>
      </div>
      <div>
        <dt>README</dt>
        <dd>{pack.readme ? "Aggregated" : "Not found"}</dd>
      </div>
    </dl>
  );
}

function SourceTab({ pack }: { pack: CatalogPack }) {
  return (
    <div className="sourceTab">
      <a className="sourceLink" href={pack.source} rel="noreferrer">
        <span>{shortSource(pack.source)}</span>
        <ExternalLink size={16} aria-hidden="true" />
      </a>
      {pack.readme ? (
        <a className="sourceLink" href={pack.readme.url} rel="noreferrer">
          <span>{shortSource(pack.readme.url)}</span>
          <ExternalLink size={16} aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

function TrustTab() {
  return (
    <div className="trustCopy">
      <ShieldCheck size={24} aria-hidden="true" />
      <p className="mutedText">
        Releases are content-addressed by the same <code>sha256:&lt;hex&gt;</code> field validated
        by Gas City's pack registry implementation. The website catalog is regenerated from source
        registries and does not add author-managed package metadata.
      </p>
    </div>
  );
}

function resolveReadmeHref(
  pack: CatalogPack,
  value: string | undefined,
  kind: "link" | "image",
) {
  if (!value) return undefined;
  if (value.startsWith("#")) return value;

  try {
    const parsed = new URL(value);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    const base =
      kind === "image" && pack.readme ? pack.readme.url : ensureTrailingSlash(pack.source);
    try {
      return new URL(value, base).toString();
    } catch {
      return undefined;
    }
  }
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
