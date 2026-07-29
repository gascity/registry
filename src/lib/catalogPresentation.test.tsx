import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PackLink } from "../components/PackLink";
import {
  PublisherAttribution,
  TierBadge,
} from "../components/RegistryPrimitives";
import { HomePage } from "../routes/HomePage";
import { PackDetail } from "../routes/PackDetail";
import type { AuthState } from "./api";
import type { CatalogPack, RegistryCatalogState } from "./registry";

function pack(over: Partial<CatalogPack> = {}): CatalogPack {
  return {
    packKey: "gascity-packs--alpha",
    registry: "gascity-packs",
    name: "alpha",
    tier: "maintained",
    publisher: "Gas City",
    description: "Alpha pack",
    source: "https://example.com/alpha",
    sourceKind: "git",
    searchText: "",
    releases: [
      {
        version: "1.0.0",
        ref: "main",
        commit: "a".repeat(40),
        hash: `sha256:${"b".repeat(64)}`,
        description: "Initial release",
        withdrawn: false,
      },
    ],
    ...over,
  };
}

const searchState = {
  query: "",
  category: "all" as const,
  author: "",
  includeWithdrawn: false,
  sort: "featured" as const,
  view: "grid" as const,
};

const anonymousAuth: AuthState = {
  user: null,
  csrfToken: null,
  authConfigured: false,
  devAuthEnabled: false,
};

describe("catalog attribution presentation", () => {
  test("tier badges carry exact visible text plus a screen-reader context prefix", () => {
    const maintained = renderToStaticMarkup(<TierBadge pack={pack()} />);
    const community = renderToStaticMarkup(
      <TierBadge pack={pack({ tier: "community" })} />,
    );
    expect(maintained).toContain("Pack tier:");
    expect(maintained).toContain("Maintained");
    expect(maintained).toContain("gc-badge--info");
    expect(community).toContain("Community");
    expect(community).toContain("gc-badge--neutral");
  });

  test("publisher attribution is inert escaped text", () => {
    const markup = renderToStaticMarkup(
      <PublisherAttribution
        pack={pack({ publisher: '<img src=x onerror="alert(1)">' })}
      />,
    );
    expect(markup).toContain("Publisher:");
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).not.toContain("<img");
  });

  test("card and list views both expose tier and publisher without adding controls", () => {
    for (const view of ["card", "list"] as const) {
      const markup = renderToStaticMarkup(
        <PackLink
          pack={pack()}
          searchState={searchState}
          view={view}
          onNavigate={() => undefined}
        />,
      );
      expect(markup).toContain("Maintained");
      expect(markup).toContain("Publisher:");
      expect(markup).toContain("Gas City");
      expect(markup.match(/<a /g)).toHaveLength(1);
      expect(markup).not.toContain("<button");
    }
  });

  test("Home renders only eligible configured Featured keys in their declared order", () => {
    const catalog: RegistryCatalogState = {
      packs: [
        pack({
          packKey: "source--unconfigured",
          name: "unconfigured",
          description: "Must not be alphabetically backfilled",
        }),
        pack({ packKey: "source--alpha", name: "alpha" }),
        pack({ packKey: "source--beta", name: "beta" }),
        pack({
          packKey: "source--unknown",
          name: "unknown",
          publisher: "Unknown publisher",
        }),
      ],
      featuredPackKeys: [
        "source--beta",
        "source--missing",
        "source--unknown",
        "source--alpha",
      ],
      sourceUrl: "/catalog.json",
      loadedFromFallback: false,
    };

    const markup = renderToStaticMarkup(
      <HomePage
        catalogStatus={{ state: "ready", catalog }}
        catalog={catalog}
        searchState={{ ...searchState, view: "list" }}
        updateSearchState={() => undefined}
        navigatePack={() => undefined}
      />,
    );
    const featured = markup.slice(
      markup.indexOf('<section class="featured"'),
      markup.indexOf('<section class="browseSection"'),
    );

    expect(featured).toContain("Selected by the Gas City Registry team.");
    expect(featured.indexOf(">beta<")).toBeGreaterThan(-1);
    expect(featured.indexOf(">alpha<")).toBeGreaterThan(
      featured.indexOf(">beta<"),
    );
    expect(featured).not.toContain(">unconfigured<");
    expect(featured).not.toContain(">unknown<");
  });

  test("Pack Detail presents catalog attribution separately from source verification", () => {
    const maintained = pack();
    const overview = renderPackDetail(maintained, "");
    const metadata = renderPackDetail(maintained, "#metadata");
    const trust = renderPackDetail(maintained, "#trust");

    expect(overview).toContain("Maintained");
    expect(overview).toContain("Publisher:");
    expect(overview).toContain("Gas City");
    expect(overview.indexOf("publisherAttribution")).toBeLessThan(
      overview.indexOf("detailSnapshot"),
    );
    expect(metadata).toContain("<dt>Tier</dt><dd>Maintained</dd>");
    expect(metadata).toContain("<dt>Publisher</dt><dd>Gas City</dd>");
    expect(trust).toContain("Catalog tier");
    expect(trust.toLowerCase()).toContain("source verification");
    expect(trust).toContain("separate");
  });
});

function renderPackDetail(candidate: CatalogPack, hash: string) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        hash,
        pathname: `/packs/${candidate.name}`,
        search: "",
      },
      history: { replaceState: () => undefined },
    },
  });
  try {
    return renderToStaticMarkup(
      <PackDetail
        catalogStatus={{
          state: "ready",
          catalog: {
            packs: [candidate],
            featuredPackKeys: [],
            sourceUrl: "/catalog.json",
            loadedFromFallback: false,
          },
        }}
        pack={candidate}
        requestedName={candidate.name}
        auth={anonymousAuth}
        signIn={() => undefined}
        devSignIn={() => undefined}
        onBack={() => undefined}
        navigateTo={() => undefined}
        navigateAuthor={() => undefined}
      />,
    );
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
