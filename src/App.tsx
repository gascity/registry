import {
  AlertTriangle,
  ArrowDownToLine,
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
  Sparkles,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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

function App() {
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>({ state: "loading" });
  const [route, setRoute] = useState<RouteState>(() => parseRoute(window.location.pathname));
  const [searchState, setSearchState] = useState(() => readSearchState(window.location.search));
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

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

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(command);
      window.setTimeout(() => setCopiedCommand(null), 1800);
    } catch {
      setCopiedCommand(null);
    }
  };

  if (route.kind === "pack") {
    return (
      <AppFrame navigateHome={() => navigateHome(searchState, true)}>
        <PackDetail
          catalogStatus={catalogStatus}
          pack={activePack}
          requestedName={route.name}
          onBack={() => navigateHome(searchState)}
          onCopy={copyCommand}
          copiedCommand={copiedCommand}
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
  onCopy,
  copiedCommand,
}: {
  catalogStatus: CatalogStatus;
  pack: CatalogPack | undefined;
  requestedName: string;
  onBack: () => void;
  onCopy: (command: string) => void;
  copiedCommand: string | null;
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
  const commands = latest ? buildImportCommands(pack, latest.version) : null;
  const sortedReleases = [...pack.releases].sort((a, b) => -compareVersions(a.version, b.version));

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
        <aside className="installPanel" aria-label="Import commands">
          <h2>Install</h2>
          {commands ? (
            <>
              <CommandBlock
                label="This version or later"
                command={commands.floating}
                copied={copiedCommand === commands.floating}
                onCopy={() => onCopy(commands.floating)}
              />
              <CommandBlock
                label="Exactly this version"
                command={commands.exact}
                copied={copiedCommand === commands.exact}
                onCopy={() => onCopy(commands.exact)}
              />
            </>
          ) : (
            <p className="mutedText">This pack has no active release to import.</p>
          )}
        </aside>
      </section>

      <section className="detailGrid">
        <div className="detailMain">
          <Panel title="Releases" icon={<ArrowDownToLine size={18} />}>
            <div className="releaseTable">
              {sortedReleases.map((release) => (
                <ReleaseRow key={`${release.version}-${release.commit}`} release={release} />
              ))}
            </div>
          </Panel>
        </div>

        <aside className="detailAside">
          <Panel title="Metadata" icon={<FileCode2 size={18} />}>
            <dl className="metadataList">
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
                <dd>{pack.releases.filter((release) => !release.withdrawn).length}</dd>
              </div>
              <div>
                <dt>Withdrawn releases</dt>
                <dd>{pack.releases.filter((release) => release.withdrawn).length}</dd>
              </div>
            </dl>
          </Panel>

          <Panel title="Source" icon={<GitBranch size={18} />}>
            <a className="sourceLink" href={pack.source} rel="noreferrer">
              <span>{shortSource(pack.source)}</span>
              <ExternalLink size={16} aria-hidden="true" />
            </a>
          </Panel>

          <Panel title="Trust model" icon={<ShieldCheck size={18} />}>
            <p className="mutedText">
              Releases are content-addressed by the same <code>sha256:&lt;hex&gt;</code> field
              validated by Gas City's pack registry implementation.
            </p>
          </Panel>
        </aside>
      </section>
    </main>
  );
}

function CommandBlock({
  label,
  command,
  copied,
  onCopy,
}: {
  label: string;
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="commandBlock">
      <span>{label}</span>
      <code>{command}</code>
      <button type="button" onClick={onCopy} aria-label={`Copy ${label} command`}>
        {copied ? <CheckCircle2 size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

function Panel({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <span aria-hidden="true">{icon}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
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
      pack.description,
      pack.source,
      categoryForPack(pack).label,
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
