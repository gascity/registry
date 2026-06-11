import { KeyRound, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import { apiRequest, type ApiTokenCreateResult, type AuthState } from "../lib/api";

type CliAuthTokenResponse = {
  token: ApiTokenCreateResult;
  registryUrl: string;
  redirectUri: string;
  state: string;
};

export function CliAuthPage({
  auth,
  signIn,
  devSignIn,
}: {
  auth: AuthState;
  signIn: () => void;
  devSignIn: () => void;
}) {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";
  const label = params.get("label") ?? "GC CLI browser login";
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!auth.user) {
    return (
      <main className="accountPage">
        <section className="signInPromptInline large">
          <Terminal size={24} />
          <strong>Sign in to authorize the CLI.</strong>
          <p>The CLI will receive a registry API token after you approve this request.</p>
          <div className="promptActions">
            {auth.devAuthEnabled ? (
              <button className="iconTextButton" type="button" onClick={devSignIn}>
                Dev sign in
              </button>
            ) : null}
            <button className="iconTextButton primary" type="button" onClick={signIn}>
              Sign in
            </button>
          </div>
        </section>
      </main>
    );
  }

  const authorize = async () => {
    if (!auth.csrfToken || isAuthorizing) return;
    setIsAuthorizing(true);
    setError(null);
    try {
      const result = await apiRequest<CliAuthTokenResponse>(
        "/api/cli/auth/token",
        {
          method: "POST",
          body: JSON.stringify({ redirectUri, state, label }),
        },
        auth.csrfToken,
      );
      const fragment = new URLSearchParams({
        token: result.token.token,
        registry: result.registryUrl,
        state: result.state,
      });
      window.location.href = `${result.redirectUri}#${fragment.toString()}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to authorize CLI.");
      setIsAuthorizing(false);
    }
  };

  return (
    <main className="accountPage">
      <header className="accountHeader">
        <p className="eyebrow">CLI login</p>
        <h1>Authorize Gas City CLI</h1>
        <p>Signed in as @{auth.user.handle}. Approving creates a revocable registry API token.</p>
      </header>

      <section className="accountPanel cliAuthPanel">
        <div className="requestTitle">
          <strong>{label}</strong>
          <span className="requestStatus approved">Local callback</span>
        </div>
        <span className="mutedText">{redirectUri || "No callback URI provided."}</span>
        <button
          className="iconTextButton primary"
          type="button"
          disabled={isAuthorizing}
          onClick={() => void authorize()}
        >
          <KeyRound size={15} />
          {isAuthorizing ? "Authorizing" : "Authorize CLI"}
        </button>
        {error ? <p className="formError" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
