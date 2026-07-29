import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { ProductShell, ShellFrame } from "@gascity/shell";
import { ProductTheme } from "@gascity/ui";
import { registryManifest, registrySubNav } from "./lib/manifest";
import { isEmbedded } from "./lib/embed";
import { stripBase, withBase } from "./lib/base";
import { PrimaryFooter } from "./components/PrimaryFooter";
import type { CatalogStatus } from "./components/RegistryPrimitives";
import { useAuthState } from "./lib/api";
import { fetchRegistryCatalog, type CatalogPack, type RegistryCatalogState } from "./lib/registry";
import {
  buildSearchString,
  packPath,
  parseRoute,
  readSearchState,
  updateUrl,
  type RouteState,
  type SearchState,
} from "./lib/urlState";
import { AccountPage } from "./routes/AccountPage";
import { AdminPublishPage } from "./routes/AdminPublishPage";
import { CliAuthPage } from "./routes/CliAuthPage";
import { CliDevicePage } from "./routes/CliDevicePage";
import { HomePage } from "./routes/HomePage";
import { PackDetail } from "./routes/PackDetail";
import { PublishPage } from "./routes/PublishPage";
import { VerifierPage } from "./routes/VerifierPage";
import "./styles.css";

function App() {
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>({ state: "loading" });
  const [route, setRoute] = useState<RouteState>(() => parseRoute(window.location.pathname));
  const [searchState, setSearchState] = useState(() => readSearchState(window.location.search));
  const { auth, isLoading: isAuthLoading, signIn, devSignIn, signOut, refresh } = useAuthState();

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
    const path = packPath(name);
    updateUrl(path, window.location.search);
    setRoute({ kind: "pack", name });
  }, []);

  const navigateTo = useCallback((path: string) => {
    updateUrl(path, "");
    setRoute(parseRoute(path));
    setSearchState(readSearchState(""));
  }, []);

  // "by {owner}" in a pack kicker lands on the home browse view filtered to that author.
  // Reset query/category/sort so the list shows ALL of the author's packs; preserve
  // includeWithdrawn (so a withdrawn-only pack reached with withdrawn=true still lists) and
  // view (cosmetic). pushState (replace=false) so browser Back returns to the pack.
  const navigateAuthor = useCallback(
    (author: string) => {
      navigateHome(
        {
          query: "",
          category: "all",
          author,
          includeWithdrawn: searchState.includeWithdrawn,
          sort: "featured",
          view: searchState.view,
        },
        false,
      );
    },
    [navigateHome, searchState],
  );

  // A pack has exactly one URL. `/packs/owner%2Fpack` still parses (shared links must keep
  // working), so rewrite it to the canonical two-segment form in place. Not routed through
  // updateUrl: that drops window.location.hash, and the ownership-verification callback lands on
  // `…#trust`. Without this, og:url — built from window.location at runtime — would differ per
  // visitor path and the encoded form would keep flowing through the edge's prefix rewrite.
  useEffect(() => {
    if (route.kind !== "pack") return;
    const canonical = packPath(route.name);
    if (stripBase(window.location.pathname) === canonical) return;
    window.history.replaceState(
      null,
      "",
      `${withBase(canonical)}${window.location.search}${window.location.hash}`,
    );
  }, [route]);

  const catalog =
    catalogStatus.state === "ready"
      ? catalogStatus.catalog
      : ({
          packs: [],
          featuredPackKeys: [],
          sourceUrl: "",
          loadedFromFallback: false,
        } satisfies RegistryCatalogState);

  const activePack =
    route.kind === "pack" ? catalog.packs.find((pack) => pack.name === route.name) : undefined;

  useEffect(
    () => updatePageMetadata(route, catalog, activePack, searchState),
    [route, catalog, activePack, searchState],
  );

  const frame = (children: React.ReactNode) => {
    // Manifest/sub-nav hrefs are logical (root-relative), so strip the mount.
    const activePath = stripBase(window.location.pathname);

    // Embedded in the apex: render only registry's window (a chromeless
    // ProductShell sub-nav). The apex owns the outer strip + rail, so rendering
    // our own ShellFrame here would nest a second full cockpit inside the apex.
    // Standalone site: the full cockpit chrome + the public footer.
    const inner = isEmbedded() ? (
      <ProductShell
        items={registrySubNav(auth.user?.role)}
        activePath={activePath}
        onNavigate={navigateTo}
        ariaLabel="Registry sections"
      >
        {children}
      </ProductShell>
    ) : (
      <ShellFrame
        manifest={registryManifest(auth.user?.role)}
        identity={{
          user: auth.user ? { name: auth.user.displayName || auth.user.handle } : null,
          isLoading: isAuthLoading,
          signInEnabled: !auth.user,
        }}
        activePath={activePath}
        onNavigate={navigateTo}
        onSignIn={() => signIn()}
        onSignOut={() => void signOut()}
      >
        {children}
        <PrimaryFooter navigateTo={navigateTo} />
      </ShellFrame>
    );

    return <ProductTheme product="registry">{inner}</ProductTheme>;
  };

  if (route.kind === "account") {
    return frame(
      <AccountPage
        auth={auth}
        signIn={() => signIn()}
        devSignIn={() => devSignIn()}
        onProfileSaved={() => void refresh()}
      />,
    );
  }

  if (route.kind === "adminPublish") {
    return frame(
      <AdminPublishPage
        auth={auth}
        signIn={() => signIn()}
        devSignIn={() => devSignIn()}
      />,
    );
  }

  if (route.kind === "verify") {
    return frame(<VerifierPage navigateTo={navigateTo} />);
  }

  if (route.kind === "publish") {
    return frame(
      <PublishPage
        navigateTo={navigateTo}
        auth={auth}
        signIn={() => signIn()}
        devSignIn={() => devSignIn()}
      />,
    );
  }

  if (route.kind === "cliAuth") {
    return frame(
      <CliAuthPage
        auth={auth}
        signIn={() => signIn()}
        devSignIn={() => devSignIn()}
      />,
    );
  }

  if (route.kind === "cliDevice") {
    return frame(
      <CliDevicePage
        auth={auth}
        signIn={() => signIn()}
        devSignIn={() => devSignIn()}
      />,
    );
  }

  if (route.kind === "pack") {
    return frame(
      <PackDetail
        catalogStatus={catalogStatus}
        pack={activePack}
        requestedName={route.name}
        auth={auth}
        signIn={() => signIn()}
        devSignIn={() => devSignIn()}
        onBack={() => navigateHome(searchState)}
        navigateTo={navigateTo}
        navigateAuthor={navigateAuthor}
      />,
    );
  }

  return frame(
    <HomePage
      catalogStatus={catalogStatus}
      catalog={catalog}
      searchState={searchState}
      updateSearchState={(next: SearchState, replace = true) => navigateHome(next, replace)}
      navigatePack={navigatePack}
    />,
  );
}

function updatePageMetadata(
  route: RouteState,
  catalog: RegistryCatalogState,
  activePack: CatalogPack | undefined,
  searchState: SearchState,
) {
  const isPack = route.kind === "pack" && activePack;
  const authorFilter = route.kind === "home" ? searchState.author.trim() : "";
  const title = isPack
    ? `${activePack.name} | Gas City Registry`
    : route.kind === "account"
      ? "Account | Gas City Registry"
      : route.kind === "adminPublish"
        ? "Publish Review | Gas City Registry"
      : route.kind === "cliAuth"
        ? "CLI Login | Gas City Registry"
      : route.kind === "cliDevice"
        ? "CLI Device Login | Gas City Registry"
      : route.kind === "verify"
        ? "Pack Ownership Verification | Gas City Registry"
        : route.kind === "publish"
          ? "Publish A Pack | Gas City Registry"
      : authorFilter
        ? `Packs by ${authorFilter} | Gas City Registry`
      : "Registry | Gas City";
  const description = isPack
    ? activePack.description
    : route.kind === "verify"
      ? "How Gas City Registry verifies pack ownership through the GitHub App verifier."
      : route.kind === "adminPublish"
        ? "Review and approve Gas City Registry direct publish requests."
      : route.kind === "cliAuth" || route.kind === "cliDevice"
        ? "Authorize Gas City CLI access to the Gas City Registry."
      : route.kind === "publish"
        ? "How to publish a new pack pointer to the Gas City Registry aggregate."
      : authorFilter
        ? `Gas City Registry packs published from GitHub source owner ${authorFilter}.`
    : "Browse versioned Gas City packs, registry releases, and import commands.";
  const imagePath = isPack ? activePack.ogImage : catalog.ogImage;
  const image = imagePath
    ? new URL(
        imagePath.startsWith("/") ? withBase(imagePath) : imagePath,
        window.location.origin,
      ).toString()
    : undefined;
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

export default App;
