import {
  AlertTriangle,
  ArrowDownToLine,
  BookOpen,
  Box,
  CheckCircle2,
  ChevronRight,
  Copy,
  ExternalLink,
  FileCode2,
  GitBranch,
  Grid2X2,
  List,
  Loader2,
  Package,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  buildImportCommands,
  categoryForPack,
  compareVersions,
  fetchRegistryCatalog,
  latestActiveRelease,
  releaseCounts,
  shortCommit,
  type CatalogPack,
  type CatalogRelease,
  type RegistryCatalogState,
} from "./lib/registry";
import "./styles.css";

type CatalogStatus =
  | { state: "loading" }
  | { state: "ready"; catalog: RegistryCatalogState }
  | { state: "error"; message: string };

type SortKey = "featured" | "name" | "latest" | "releases";
type ViewMode = "list" | "grid";
type RouteState = { kind: "home" } | { kind: "pack"; name: string };

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: "featured", label: "Featured" },
  { value: "name", label: "Name" },
  { value: "latest", label: "Latest version" },
  { value: "releases", label: "Release count" },
];

const categoryOptions = [
  { value: "workflow", label: "Workflows" },
  { value: "chatops", label: "ChatOps" },
  { value: "integration", label: "Integrations" },
  { value: "knowledge", label: "Knowledge" },
];

function parseRoute(pathname: string): RouteState {
  const match = pathname.match(/^\/packs\/([^/]+)\/?$/);
  if (!match) return { kind: "home" };
  return { kind: "pack", name: decodeURIComponent(match[1]) };
}

function readSearchState(search: string) {
  const params = new URLSearchParams(search);
  const sort = params.get("sort");
  const view = params.get("view");
  return {
    query: params.get("q") ?? "",
    category: params.get("category") ?? "all",
    includeWithdrawn: params.get("withdrawn") === "true",
    sort: sortOptions.some((option) => option.value === sort) ? (sort as SortKey) : "featured",
    view: view === "grid" ? "grid" : ("list" as ViewMode),
  };
}

function buildSearchString({
  query,
  category,
  includeWithdrawn,
  sort,
  view,
}: {
  query: string;
  category: string;
  includeWithdrawn: boolean;
  sort: SortKey;
  view: ViewMode;
}) {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (category !== "all") params.set("category", category);
  if (includeWithdrawn) params.set("withdrawn", "true");
  if (sort !== "featured") params.set("sort", sort);
  if (view === "grid") params.set("view", "grid");
  const next = params.toString();
  return next ? `?${next}` : "";
}

function updateUrl(pathname: string, search: string, replace = false) {
  const next = `${pathname}${search}`;
  if (`${window.location.pathname}${window.location.search}` === next) return;
  if (replace) {
    window.history.replaceState(null, "", next);
  } else {
    window.history.pushState(null, "", next);
  }
}

function updatePageMetadata(
  route: RouteState,
  catalog: RegistryCatalogState,
  activePack: CatalogPack | undefined,
) {
  const isPack = route.kind === "pack" && activePack;
  const title = isPack ? `${activePack.name} | Gas City Registry` : "Registry | Gas City";
  const description = isPack
    ? activePack.description
    : "Browse versioned Gas City packs, registry releases, and import commands.";
  const imagePath = isPack ? activePack.ogImage : catalog.ogImage;
  const image = imagePath ? new URL(imagePath, window.location.origin).toString() : undefined;
  const url = new URL(
    `${window.location.pathname}${window.location.search}`,
    window.location.origin,
  ).toString();

  document.title = title;
  setMeta("name", "description", description);
  setMeta("property", "og:title", title);
  setMeta("property", "og:description", description);
  setMeta("property", "og:type", "website");
  setMeta("property", "og:url", url);
  setMeta("name", "twitter:card", "summary_large_image");
  if (image) {
    setMeta("property", "og:image", image);
    setMeta("name", "twitter:image", image);
  }
}

function setMeta(attribute: "name" | "property", key: string, content: string) {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attribute, key);
    document.head.appendChild(tag);
  }
  tag.content = content;
}

function App() {
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>({ state: "loading" });
  const [route, setRoute] = useState<RouteState>(() => parseRoute(window.location.pathname));
  const [searchState, setSearchState] = useState(() => readSearchState(window.location.search));

  useEffect(() => {
    let active = true;
    fetchRegistryCatalog()
      .then((catalog) => {
        if (active) setCatalogStatus({ state: "ready", catalog });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Unable to load registry catalog.";
        setCatalogStatus({ state: "error", message });
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname));
      setSearchState(readSearchState(window.location.search));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigateHome = useCallback((nextSearchState = searchState, replace = false) => {
    const search = buildSearchString(nextSearchState);
    updateUrl("/", search, replace);
    setRoute({ kind: "home" });
    setSearchState(nextSearchState);
  }, [searchState]);

  const navigatePack = useCallback((name: string) => {
    const path = `/packs/${encodeURIComponent(name)}`;
    updateUrl(path, window.location.search);
    setRoute({ kind: "pack", name });
  }, []);

  const catalog =
    catalogStatus.state === "ready"
      ? catalogStatus.catalog
      : ({ packs: [], sourceUrl: "", loadedFromFallback: false } satisfies RegistryCatalogState);

  const activePack =
    route.kind === "pack" ? catalog.packs.find((pack) => pack.name === route.name) : undefined;

  useEffect(() => updatePageMetadata(route, catalog, activePack), [route, catalog, activePack]);

  if (route.kind === "pack") {
    return (
      <AppFrame navigateHome={() => navigateHome(searchState, true)}>
        <PackDetail
          catalogStatus={catalogStatus}
          pack={activePack}
          requestedName={route.name}
          onBack={() => navigateHome(searchState)}
        />
      </AppFrame>
    );
  }

  return (
    <AppFrame navigateHome={() => navigateHome(searchState, true)}>
      <HomePage
        catalogStatus={catalogStatus}
        catalog={catalog}
        searchState={searchState}
        updateSearchState={(next, replace = true) => navigateHome(next, replace)}
        navigatePack={navigatePack}
      />
    </AppFrame>
  );
}

function AppFrame({
  children,
  navigateHome,
}: {
  children: React.ReactNode;
  navigateHome: () => void;
}) {
  return (
    <div className="app">
      <header className="siteHeader">
        <button className="brandButton" type="button" onClick={navigateHome}>
          <span className="brandMark" aria-hidden="true">
            <Package size={18} />
          </span>
          <span>
            <strong>Gas City</strong>
            <small>Pack Registry</small>
          </span>
        </button>
        <nav className="siteNav" aria-label="Primary navigation">
          <a
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigateHome();
            }}
          >
            Browse
          </a>
          <a href="https://github.com/gastownhall/gascity-packs" rel="noreferrer">
            Source
          </a>
          <a href="https://github.com/gastownhall/gascity" rel="noreferrer">
            Gas City
          </a>
        </nav>
      </header>
      {children}
    </div>
  );
}

function HomePage({
  catalogStatus,
  catalog,
  searchState,
  updateSearchState,
  navigatePack,
}: {
  catalogStatus: CatalogStatus;
  catalog: RegistryCatalogState;
  searchState: ReturnType<typeof readSearchState>;
  updateSearchState: (next: ReturnType<typeof readSearchState>, replace?: boolean) => void;
  navigatePack: (name: string) => void;
}) {
  const counts = useMemo(() => releaseCounts(catalog.packs), [catalog.packs]);
  const featuredPacks = useMemo(() => catalog.packs.slice(0, 4), [catalog.packs]);
  const filteredPacks = useMemo(
    () => filterAndSortPacks(catalog.packs, searchState),
    [catalog.packs, searchState],
  );

  const setSearchField = <K extends keyof typeof searchState>(
    key: K,
    value: (typeof searchState)[K],
  ) => {
    updateSearchState({ ...searchState, [key]: value });
  };

  return (
    <main>
      <section className="hero">
        <div className="heroCopy">
          <p className="eyebrow">First-party pack catalog</p>
          <h1>Registry</h1>
          <p className="heroSummary">
            Discover versioned Gas City workflow packs, review immutable content hashes, and copy
            import commands that match `gc pack registry show`.
          </p>
          <form
            className="heroSearch"
            onSubmit={(event) => {
              event.preventDefault();
              updateSearchState(searchState);
            }}
          >
            <Search size={18} aria-hidden="true" />
            <input
              type="search"
              value={searchState.query}
              onChange={(event) => setSearchField("query", event.target.value)}
              placeholder="Search packs, integrations, workflows..."
              aria-label="Search registry packs"
            />
          </form>
        </div>
        <img
          className="heroImage"
          src="/registry-map.png"
          alt="Stylized service-node map representing Gas City pack composition"
        />
      </section>

      <section className="statsStrip" aria-label="Registry summary">
        <Metric value={catalog.packs.length} label="packs" />
        <Metric value={counts.active} label="active releases" />
        <Metric value={counts.withdrawn} label="withdrawn" />
        <Metric value="sha256" label="content identity" />
      </section>

      {featuredPacks.length > 0 ? (
        <section className="featured" aria-labelledby="featured-title">
          <div className="sectionTitle">
            <p className="eyebrow">Start here</p>
            <h2 id="featured-title">Featured packs</h2>
          </div>
          <div className="featuredGrid">
            {featuredPacks.map((pack) => (
              <PackCard key={pack.name} pack={pack} onOpen={navigatePack} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="browseSection" aria-labelledby="browse-title">
        <div className="browseHeader">
          <button className="filterButton" type="button" aria-label="Filters">
            <SlidersHorizontal size={16} />
            Filters
          </button>
          <div>
            <p className="eyebrow">Browse</p>
            <h2 id="browse-title">
              Packs <span>{filteredPacks.length}</span>
            </h2>
          </div>
        </div>

        <div className="browseLayout">
          <aside className="browseSidebar" aria-label="Browse filters">
            <fieldset>
              <legend>Sort by</legend>
              {sortOptions.map((option) => (
                <button
                  key={option.value}
                  className={searchState.sort === option.value ? "active" : ""}
                  type="button"
                  onClick={() => setSearchField("sort", option.value)}
                >
                  {option.label}
                </button>
              ))}
            </fieldset>
            <fieldset>
              <legend>Categories</legend>
              <button
                className={searchState.category === "all" ? "active" : ""}
                type="button"
                onClick={() => setSearchField("category", "all")}
              >
                All
              </button>
              {categoryOptions.map((option) => (
                <button
                  key={option.value}
                  className={searchState.category === option.value ? "active" : ""}
                  type="button"
                  onClick={() => setSearchField("category", option.value)}
                >
                  {option.label}
                </button>
              ))}
            </fieldset>
            <fieldset>
              <legend>Release state</legend>
              <label className="checkboxRow">
                <input
                  type="checkbox"
                  checked={searchState.includeWithdrawn}
                  onChange={(event) => setSearchField("includeWithdrawn", event.target.checked)}
                />
                <span>Show withdrawn releases</span>
              </label>
            </fieldset>
          </aside>

          <div className="browseResults">
            <div className="resultsToolbar">
              <span>
                {catalogStatus.state === "loading"
                  ? "Loading packs"
                  : `${filteredPacks.length} result${filteredPacks.length === 1 ? "" : "s"}`}
              </span>
              <div className="viewToggle" aria-label="View mode">
                <button
                  className={searchState.view === "list" ? "active" : ""}
                  type="button"
                  aria-label="List view"
                  onClick={() => setSearchField("view", "list")}
                >
                  <List size={16} />
                </button>
                <button
                  className={searchState.view === "grid" ? "active" : ""}
                  type="button"
                  aria-label="Grid view"
                  onClick={() => setSearchField("view", "grid")}
                >
                  <Grid2X2 size={16} />
                </button>
              </div>
            </div>

            <CatalogLoadState catalogStatus={catalogStatus} />

            {catalogStatus.state === "ready" && filteredPacks.length === 0 ? (
              <EmptyState
                title="No packs found"
                body="Try another search term, switch category, or include withdrawn releases."
              />
            ) : null}

            {catalogStatus.state === "ready" && filteredPacks.length > 0 ? (
              <div className={searchState.view === "grid" ? "packGrid" : "packList"}>
                {filteredPacks.map((pack) =>
                  searchState.view === "grid" ? (
                    <PackCard key={pack.name} pack={pack} onOpen={navigatePack} />
                  ) : (
                    <PackListItem key={pack.name} pack={pack} onOpen={navigatePack} />
                  ),
                )}
              </div>
            ) : null}

            {catalogStatus.state === "ready" ? (
              <p className="sourceNote">
                Catalog source: <code>{catalog.sourceUrl}</code>
                {catalog.loadedFromFallback ? " (fallback)" : ""}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

function Metric({ value, label }: { value: number | string; label: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function CatalogLoadState({ catalogStatus }: { catalogStatus: CatalogStatus }) {
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

function PackCard({ pack, onOpen }: { pack: CatalogPack; onOpen: (name: string) => void }) {
  const latest = latestActiveRelease(pack);
  return (
    <button className="packCard" type="button" onClick={() => onOpen(pack.name)}>
      <div className="packCardHeader">
        <PackIcon pack={pack} />
        <StatusBadge pack={pack} />
      </div>
      <h3>{pack.name}</h3>
      <p>{pack.description}</p>
      <div className="packMeta">
        <span>{categoryForPack(pack).label}</span>
        <span>{latest ? `v${latest.version}` : "No active release"}</span>
        <span>{pack.releases.length} releases</span>
      </div>
    </button>
  );
}

function PackListItem({ pack, onOpen }: { pack: CatalogPack; onOpen: (name: string) => void }) {
  const latest = latestActiveRelease(pack);
  const category = categoryForPack(pack);
  return (
    <button className="packListItem" type="button" onClick={() => onOpen(pack.name)}>
      <PackIcon pack={pack} />
      <span className="packListBody">
        <span className="packListTitle">
          <strong>{pack.name}</strong>
          <StatusBadge pack={pack} />
        </span>
        <span>{pack.description}</span>
        <span className="packMeta">
          <span>{category.label}</span>
          <span>{latest ? `v${latest.version}` : "No active release"}</span>
          <span>{shortSource(pack.source)}</span>
        </span>
      </span>
      <ChevronRight size={18} aria-hidden="true" />
    </button>
  );
}

function PackDetail({
  catalogStatus,
  pack,
  requestedName,
  onBack,
}: {
  catalogStatus: CatalogStatus;
  pack: CatalogPack | undefined;
  requestedName: string;
  onBack: () => void;
}) {
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
          </dl>
        </aside>
      </section>

      <PackDetailTabs pack={pack} latest={latest} sortedReleases={sortedReleases} />
    </main>
  );
}

type DetailTabId = "readme" | "install" | "releases" | "metadata" | "source" | "trust";

type DetailTab = {
  id: DetailTabId;
  label: string;
  icon: React.ReactNode;
};

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

  return (
    <section className="tabCard" aria-label="Pack details">
      <div className="tabHeader" role="tablist" aria-label={`${pack.name} detail tabs`}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? "tabButton active" : "tabButton"}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`pack-tabpanel-${tab.id}`}
            id={`pack-tab-${tab.id}`}
            onClick={() => selectTab(tab.id)}
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

function CommandBlock({
  label,
  command,
}: {
  label: string;
  command: string;
}) {
  return (
    <div className="commandBlock">
      <span>{label}</span>
      <code>{command}</code>
      <CopyButton text={command} ariaLabel={`Copy ${label} command`} />
    </div>
  );
}

type CopyState = "idle" | "copied" | "failed";

function CopyButton({ text, ariaLabel }: { text: string; ariaLabel: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimeoutRef.current !== null) window.clearTimeout(resetTimeoutRef.current);
    },
    [],
  );

  const scheduleReset = () => {
    if (resetTimeoutRef.current !== null) window.clearTimeout(resetTimeoutRef.current);
    resetTimeoutRef.current = window.setTimeout(() => {
      setCopyState("idle");
      resetTimeoutRef.current = null;
    }, 2000);
  };

  const buttonLabel =
    copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy";

  return (
    <button
      className="copyButton"
      type="button"
      data-copy-state={copyState}
      aria-label={ariaLabel}
      onClick={() => {
        void copyText(text)
          .then((didCopy) => {
            setCopyState(didCopy ? "copied" : "failed");
            scheduleReset();
          })
          .catch(() => {
            setCopyState("failed");
            scheduleReset();
          });
      }}
    >
      {copyState === "copied" ? (
        <CheckCircle2 size={16} aria-hidden="true" />
      ) : (
        <Copy size={16} aria-hidden="true" />
      )}
      <span aria-live="polite">{buttonLabel}</span>
    </button>
  );
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  if (typeof document.execCommand !== "function") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function ReleaseRow({ release }: { release: CatalogRelease }) {
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

function StatusBadge({ pack }: { pack: CatalogPack }) {
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

function PackIcon({ pack }: { pack: CatalogPack }) {
  const category = categoryForPack(pack);
  const Icon = category.icon;
  return (
    <span className="packIcon" aria-hidden="true">
      <Icon size={18} />
    </span>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="emptyState">
      <Box size={24} aria-hidden="true" />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function shortSource(source: string) {
  try {
    const url = new URL(source);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return source;
  }
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

function filterAndSortPacks(
  packs: CatalogPack[],
  searchState: ReturnType<typeof readSearchState>,
) {
  const normalizedQuery = searchState.query.trim().toLowerCase();
  const filtered = packs.filter((pack) => {
    const latest = latestActiveRelease(pack);
    if (!searchState.includeWithdrawn && !latest) return false;
    if (searchState.category !== "all" && categoryForPack(pack).value !== searchState.category) {
      return false;
    }
    if (!normalizedQuery) return true;
    return [
      pack.name,
      pack.registry,
      pack.description,
      pack.source,
      categoryForPack(pack).label,
      pack.readme?.content ?? "",
      ...pack.releases.map((release) => `${release.version} ${release.description}`),
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });

  return filtered.sort((a, b) => {
    if (searchState.sort === "name") return a.name.localeCompare(b.name);
    if (searchState.sort === "latest") {
      return compareVersions(
        latestActiveRelease(b)?.version ?? "0.0.0",
        latestActiveRelease(a)?.version ?? "0.0.0",
      );
    }
    if (searchState.sort === "releases") return b.releases.length - a.releases.length;
    const left = latestActiveRelease(a) ? 0 : 1;
    const right = latestActiveRelease(b) ? 0 : 1;
    return left - right || a.name.localeCompare(b.name);
  });
}

export default App;
