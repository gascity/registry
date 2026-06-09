import { Grid2X2, List, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "../components/CopyButton";
import { PackLink } from "../components/PackLink";
import {
  CatalogLoadState,
  EmptyState,
  Metric,
  type CatalogStatus,
} from "../components/RegistryPrimitives";
import { filterAndSortPacks } from "../lib/catalogFilters";
import { releaseCounts, type RegistryCatalogState } from "../lib/registry";
import {
  categoryOptions,
  sortOptions,
  type SearchState,
} from "../lib/urlState";

const registryEndpoint =
  typeof window === "undefined"
    ? "https://registry.gascity.com/registry.toml"
    : `${window.location.origin}/registry.toml`;

export function HomePage({
  catalogStatus,
  catalog,
  searchState,
  updateSearchState,
  navigatePack,
}: {
  catalogStatus: CatalogStatus;
  catalog: RegistryCatalogState;
  searchState: SearchState;
  updateSearchState: (next: SearchState, replace?: boolean) => void;
  navigatePack: (name: string) => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeFiltersRef = useRef<HTMLButtonElement | null>(null);
  const counts = useMemo(() => releaseCounts(catalog.packs), [catalog.packs]);
  const featuredPacks = useMemo(() => catalog.packs.slice(0, 4), [catalog.packs]);
  const filteredPacks = useMemo(
    () => filterAndSortPacks(catalog.packs, searchState),
    [catalog.packs, searchState],
  );

  useEffect(() => {
    if (filtersOpen) closeFiltersRef.current?.focus();
  }, [filtersOpen]);

  useEffect(() => {
    if (!filtersOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFilters(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filtersOpen]);

  const setSearchField = <K extends keyof SearchState>(key: K, value: SearchState[K]) => {
    updateSearchState({ ...searchState, [key]: value });
  };

  const closeFilters = (restoreFocus = false) => {
    setFiltersOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => filterButtonRef.current?.focus());
  };

  const clearFilters = () => {
    updateSearchState({
      query: "",
      category: "all",
      includeWithdrawn: false,
      sort: "featured",
      view: searchState.view,
    });
  };

  const activeFilters = activeFilterLabels(searchState);

  const filterSidebar = (
    <aside className={filtersOpen ? "browseSidebar open" : "browseSidebar"} aria-label="Browse filters">
      <div className="mobileFilterHeader">
        <strong>Filters</strong>
        <button
          ref={closeFiltersRef}
          type="button"
          className="iconOnlyButton"
          aria-label="Close filters"
          onClick={() => closeFilters(true)}
        >
          <X size={16} />
        </button>
      </div>
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
      {activeFilters.length > 0 ? (
        <button className="clearFiltersButton" type="button" onClick={clearFilters}>
          Clear filters
        </button>
      ) : null}
    </aside>
  );

  return (
    <main>
      <section className="hero compactHero">
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

        <aside className="endpointPanel" aria-label="CLI registry endpoint">
          <p className="eyebrow">CLI endpoint</p>
          <code>{registryEndpoint}</code>
          <CopyButton text={registryEndpoint} ariaLabel="Copy registry TOML endpoint" />
          <p>Use this URL anywhere `gc` expects a pack registry.</p>
        </aside>
      </section>

      <section className="statsStrip compactStats" aria-label="Registry summary">
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
              <PackLink
                key={pack.name}
                pack={pack}
                searchState={searchState}
                view="card"
                onNavigate={navigatePack}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="browseSection" aria-labelledby="browse-title">
        <div className="browseHeader">
          <button
            ref={filterButtonRef}
            className="filterButton"
            type="button"
            onClick={() => setFiltersOpen(true)}
          >
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

        {filtersOpen ? (
          <div className="filterBackdrop" onClick={() => closeFilters(true)} aria-hidden="true" />
        ) : null}
        <div className="browseLayout">
          {filterSidebar}
          <div className="browseResults">
            {activeFilters.length > 0 ? (
              <div className="activeFilters" aria-label="Active filters">
                {activeFilters.map((label) => (
                  <span key={label}>{label}</span>
                ))}
                <button type="button" onClick={clearFilters}>
                  Clear
                </button>
              </div>
            ) : null}
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
                {filteredPacks.map((pack) => (
                  <PackLink
                    key={pack.name}
                    pack={pack}
                    searchState={searchState}
                    view={searchState.view === "grid" ? "card" : "list"}
                    onNavigate={navigatePack}
                  />
                ))}
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

function activeFilterLabels(searchState: SearchState) {
  const labels: string[] = [];
  if (searchState.query.trim()) labels.push(`Search: ${searchState.query.trim()}`);
  const category = categoryOptions.find((option) => option.value === searchState.category);
  if (category) labels.push(category.label);
  if (searchState.includeWithdrawn) labels.push("Withdrawn included");
  const sort = sortOptions.find((option) => option.value === searchState.sort);
  if (sort && sort.value !== "featured") labels.push(`Sort: ${sort.label}`);
  return labels;
}
