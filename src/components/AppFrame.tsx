import { LogIn, LogOut, Package, UserRound } from "lucide-react";
import type React from "react";
import type { AuthState } from "../lib/api";

export function AppFrame({
  children,
  auth,
  isAuthLoading,
  navigateHome,
  navigateAccount,
  signIn,
  devSignIn,
  signOut,
}: {
  children: React.ReactNode;
  auth: AuthState;
  isAuthLoading: boolean;
  navigateHome: () => void;
  navigateAccount: () => void;
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
          <a href="https://github.com/gastownhall/gascity-packs" rel="noreferrer">
            Source
          </a>
          <a href="https://github.com/gastownhall/gascity" rel="noreferrer">
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
    </div>
  );
}
