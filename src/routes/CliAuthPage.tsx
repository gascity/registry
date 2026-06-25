import { KeyRound, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AppPage,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Text,
} from "@gascity/ui";
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
      <div className="accountPage">
        <EmptyState
          className="signInPromptInline large"
          icon={<Terminal size={24} />}
          title="Sign in to authorize the CLI."
          description="The CLI will receive a registry API token after you approve this request."
          action={
            <div className="promptActions">
              {auth.devAuthEnabled ? (
                <Button variant="secondary" onClick={devSignIn}>
                  Dev sign in
                </Button>
              ) : null}
              <Button onClick={signIn}>Sign in</Button>
            </div>
          }
        />
      </div>
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
    <AppPage
      className="accountPage"
      eyebrow="CLI login"
      title="Authorize Gas City CLI"
      subtitle={`Signed in as @${auth.user.handle}. Approving creates a revocable registry API token.`}
    >
      <Card variant="panel" className="cliAuthPanel">
        <CardHeader
          title={label}
          icon={<Terminal size={16} />}
          action={<Badge status="info">Local callback</Badge>}
        />
        <Text tone="muted">{redirectUri || "No callback URI provided."}</Text>
        <Button
          iconStart={<KeyRound size={15} />}
          loading={isAuthorizing}
          onClick={() => void authorize()}
        >
          {isAuthorizing ? "Authorizing" : "Authorize CLI"}
        </Button>
        {error ? (
          <Text className="formError" role="alert">
            {error}
          </Text>
        ) : null}
      </Card>
    </AppPage>
  );
}
