import { ExternalLink, LogIn, LogOut, Package, UserRound } from "lucide-react";
import type React from "react";
import type { AuthState } from "../lib/api";
import { GASCITY_HOME_URL, REGISTRY_SOURCE_URL } from "../lib/links";

export function AppFrame({
  children,
  auth,
  isAuthLoading,
  navigateHome,
  navigateAccount,
  navigateTo,
  signIn,
  devSignIn,
  signOut,
}: {
  children: React.ReactNode;
  auth: AuthState;
  isAuthLoading: boolean;
  navigateHome: () => void;
  navigateAccount: () => void;
  navigateTo: (path: string) => void;
  signIn: () => void;
  devSignIn: () => void;
  signOut: () => void;
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
          {auth.user?.role === "admin" || auth.user?.role === "moderator" ? (
            <a
              href="/admin/publish-requests"
              onClick={(event) => {
                event.preventDefault();
                navigateTo("/admin/publish-requests");
              }}
            >
              Review
            </a>
          ) : null}
          <a href={GASCITY_HOME_URL} rel="noreferrer">
            Gas City
          </a>
        </nav>
        <div className="accountNav">
          {isAuthLoading ? (
            <span className="authStatus">Checking session</span>
          ) : auth.user ? (
            <>
              <button className="accountButton" type="button" onClick={navigateAccount}>
                <UserRound size={16} aria-hidden="true" />
                <span>{auth.user.displayName || auth.user.handle}</span>
              </button>
              <button className="iconTextButton" type="button" onClick={signOut}>
                <LogOut size={16} aria-hidden="true" />
                Sign out
              </button>
            </>
          ) : (
            <>
              {auth.devAuthEnabled ? (
                <button className="iconTextButton" type="button" onClick={devSignIn}>
                  <UserRound size={16} aria-hidden="true" />
                  Dev sign in
                </button>
              ) : null}
              <button className="iconTextButton primary" type="button" onClick={signIn}>
                <LogIn size={16} aria-hidden="true" />
                Sign in
              </button>
            </>
          )}
        </div>
      </header>
      {children}
      <footer className="siteFooter">
        <div>
          <strong>Gas City Registry</strong>
          <span>Aggregate catalog and trust metadata for published packs.</span>
        </div>
        <nav className="footerNav" aria-label="Registry resources">
          <a
            href="/publish"
            onClick={(event) => {
              event.preventDefault();
              navigateTo("/publish");
            }}
          >
            Publish a pack
          </a>
          <a
            href="/verify"
            onClick={(event) => {
              event.preventDefault();
              navigateTo("/verify");
            }}
          >
            Verification flow
          </a>
          <a href={REGISTRY_SOURCE_URL} rel="noreferrer">
            Source
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </nav>
      </footer>
    </div>
  );
}
