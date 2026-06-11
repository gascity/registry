import { CheckCircle2, Terminal, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { apiRequest, type AuthState } from "../lib/api";

export function CliDevicePage({
  auth,
  signIn,
  devSignIn,
}: {
  auth: AuthState;
  signIn: () => void;
  devSignIn: () => void;
}) {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [userCode, setUserCode] = useState(params.get("code") ?? "");
  const [isWorking, setIsWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!auth.user) {
    return (
      <main className="accountPage">
        <section className="signInPromptInline large">
          <Terminal size={24} />
          <strong>Sign in to approve CLI access.</strong>
          <p>Enter the device code shown in your terminal after signing in.</p>
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

  const submit = async (action: "approve" | "deny") => {
    if (!auth.csrfToken || isWorking) return;
    setIsWorking(true);
    setNotice(null);
    setError(null);
    try {
      await apiRequest(
        `/api/cli/device/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ userCode }),
        },
        auth.csrfToken,
      );
      setNotice(action === "approve" ? "CLI login approved. Return to your terminal." : "CLI login denied.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update device login.");
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <main className="accountPage">
      <header className="accountHeader">
        <p className="eyebrow">CLI device login</p>
        <h1>Approve CLI access</h1>
        <p>Signed in as @{auth.user.handle}. Approval creates a revocable registry API token.</p>
      </header>

      <section className="accountPanel cliAuthPanel">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit("approve");
          }}
        >
          <label>
            <span>Device code</span>
            <input
              value={userCode}
              onChange={(event) => setUserCode(event.target.value.toUpperCase())}
              placeholder="ABCD-2345"
              autoFocus
            />
          </label>
          <div className="promptActions">
            <button className="iconTextButton primary" type="submit" disabled={isWorking}>
              <CheckCircle2 size={15} />
              {isWorking ? "Approving" : "Approve"}
            </button>
            <button
              className="iconTextButton"
              type="button"
              disabled={isWorking}
              onClick={() => void submit("deny")}
            >
              <XCircle size={15} />
              Deny
            </button>
          </div>
        </form>
        {notice ? <p className="formNotice">{notice}</p> : null}
        {error ? <p className="formError" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
