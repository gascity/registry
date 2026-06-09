import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { AppFrame } from "./components/AppFrame";
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
import { HomePage } from "./routes/HomePage";
import { PackDetail } from "./routes/PackDetail";
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

  const navigateAccount = useCallback(() => {
    updateUrl("/account", "");
    setRoute({ kind: "account" });
  }, []);

  const catalog =
    catalogStatus.state === "ready"
      ? catalogStatus.catalog
      : ({ packs: [], sourceUrl: "", loadedFromFallback: false } satisfies RegistryCatalogState);

  const activePack =
    route.kind === "pack" ? catalog.packs.find((pack) => pack.name === route.name) : undefined;

  useEffect(() => updatePageMetadata(route, catalog, activePack), [route, catalog, activePack]);

  const frame = (children: React.ReactNode) => (
    <AppFrame
      auth={auth}
      isAuthLoading={isAuthLoading}
      navigateHome={() => navigateHome(searchState, true)}
      navigateAccount={navigateAccount}
      signIn={() => signIn()}
      devSignIn={() => devSignIn()}
      signOut={() => void signOut()}
    >
      {children}
    </AppFrame>
  );

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
) {
  const isPack = route.kind === "pack" && activePack;
  const title = isPack
    ? `${activePack.name} | Gas City Registry`
    : route.kind === "account"
      ? "Account | Gas City Registry"
      : "Registry | Gas City";
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

export default App;
