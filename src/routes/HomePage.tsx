import { Grid2X2, List, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AppPage,
  Card,
  Eyebrow,
  Input,
  SegmentedControl,
  StatGrid,
} from "@gascity/ui";
import { CopyButton } from "../components/CopyButton";
import { PackLink } from "../components/PackLink";
import {
  CatalogLoadState,
  EmptyState,
  Metric,
  type CatalogStatus,
} from "../components/RegistryPrimitives";
import { selectFeaturedPacks } from "../lib/catalogCuration";
import { filterAndSortPacks } from "../lib/catalogFilters";
import { releaseCounts, type RegistryCatalogState } from "../lib/registry";
import { REGISTRY_PUBLIC_URL } from "../lib/links";
import { isEmbedded } from "../lib/embed";
import {
  categoryOptions,
  hasActiveSearch,
  sortOptions,
  type SearchState,
  type SortKey,
  type ViewMode,
} from "../lib/urlState";

// Standalone: advertise this host's own origin (registry.gascity.com in prod).
// Embedded in the apex: pin the canonical public origin, never works.gascity.com.
const registryEndpoint = `${
  typeof window !== "undefined" && !isEmbedded() ? window.location.origin : REGISTRY_PUBLIC_URL
}/registry.toml`;

const summary =
  "Discover versioned Gas City workflow packs, review immutable content hashes, and copy import commands that match `gc pack registry show`.";

const viewOptions: { value: ViewMode; label: ReactNode }[] = [
  {
    value: "list",
    label: (
      <>
        <List size={16} aria-hidden="true" />
        <span className="gc-sr-only">List view</span>
      </>
    ),
  },
  {
    value: "grid",
    label: (
      <>
        <Grid2X2 size={16} aria-hidden="true" />
        <span className="gc-sr-only">Grid view</span>
      </>
    ),
  },
];

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
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchActive = hasActiveSearch(searchState);
  const counts = useMemo(() => releaseCounts(catalog.packs), [catalog.packs]);
  const featuredPacks = useMemo(
    () => selectFeaturedPacks(catalog.packs, catalog.featuredPackKeys),
    [catalog.featuredPackKeys, catalog.packs],
  );
  const filteredPacks = useMemo(
    () => filterAndSortPacks(catalog.packs, searchState, catalog.featuredPackKeys),
    [catalog.featuredPackKeys, catalog.packs, searchState],
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
      author: "",
      includeWithdrawn: false,
      sort: "featured",
      view: searchState.view,
    });
    // The Clear affordance that had focus just unmounted. Keep focus contained on the
    // sheet's Close button while it's open; on the desktop layout restore it to the
    // search input — but never on touch, where focusing an input summons the keyboard.
    if (filtersOpen) {
      closeFiltersRef.current?.focus();
    } else if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      searchInputRef.current?.focus();
    }
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
        <SegmentedControl<SortKey>
          ariaLabel="Sort by"
          options={sortOptions}
          value={searchState.sort}
          onChange={(value) => setSearchField("sort", value)}
        />
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
      <AppPage eyebrow="Registry · Catalog" title="Registry" subtitle={summary}>
        <section className="hero compactHero">
          <form
            className="heroSearch"
            onSubmit={(event) => {
              event.preventDefault();
              updateSearchState(searchState);
            }}
          >
            <Input
              ref={searchInputRef}
              label="Search registry packs"
              type="search"
              value={searchState.query}
              onChange={(event) => setSearchField("query", event.target.value)}
              placeholder="Search packs, integrations, workflows..."
            />
          </form>

          {!searchActive ? (
            <Card
              variant="panel"
              className="endpointPanel"
              aria-label="CLI registry endpoint"
            >
              <Eyebrow>CLI endpoint</Eyebrow>
              <code>{registryEndpoint}</code>
              <CopyButton text={registryEndpoint} ariaLabel="Copy registry TOML endpoint" />
            </Card>
          ) : null}
        </section>

        {!searchActive ? (
          <section className="statsStrip compactStats" aria-label="Registry summary">
            <StatGrid>
              <Metric value={catalog.packs.length} label="packs" />
              <Metric value={counts.active} label="active releases" />
              <Metric value={counts.withdrawn} label="withdrawn" />
              <Metric value="sha256" label="content identity" />
            </StatGrid>
          </section>
        ) : null}

        {!searchActive && featuredPacks.length > 0 ? (
          <section className="featured" aria-labelledby="featured-title">
            <div className="sectionTitle">
              <Eyebrow>Start here</Eyebrow>
              <h2 id="featured-title">Featured packs</h2>
              <p>Selected by the Gas City Registry team.</p>
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

        <section
          className={searchActive ? "browseSection searchActive" : "browseSection"}
          aria-labelledby="browse-title"
        >
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
              <Eyebrow>Browse</Eyebrow>
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
                <span role="status">
                  {catalogStatus.state === "loading"
                    ? "Loading packs"
                    : `${filteredPacks.length} result${filteredPacks.length === 1 ? "" : "s"}`}
                </span>
                <SegmentedControl<ViewMode>
                  ariaLabel="View mode"
                  options={viewOptions}
                  value={searchState.view}
                  onChange={(value) => setSearchField("view", value)}
                />
              </div>

              <CatalogLoadState catalogStatus={catalogStatus} />

              {catalogStatus.state === "ready" && filteredPacks.length === 0 ? (
                <EmptyState
                  title="No packs found"
                  description="Try another search term, switch category, or include withdrawn releases."
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
      </AppPage>
    </main>
  );
}

function activeFilterLabels(searchState: SearchState) {
  const labels: string[] = [];
  if (searchState.query.trim()) labels.push(`Search: ${searchState.query.trim()}`);
  const category = categoryOptions.find((option) => option.value === searchState.category);
  if (category) labels.push(category.label);
  if (searchState.author.trim()) labels.push(`Author: ${searchState.author.trim()}`);
  if (searchState.includeWithdrawn) labels.push("Withdrawn included");
  const sort = sortOptions.find((option) => option.value === searchState.sort);
  if (sort && sort.value !== "featured") labels.push(`Sort: ${sort.label}`);
  return labels;
}
