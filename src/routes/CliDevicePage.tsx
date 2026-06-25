import { CheckCircle2, Terminal, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AppPage,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  Text,
} from "@gascity/ui";
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
      <div className="accountPage">
        <EmptyState
          className="signInPromptInline large"
          icon={<Terminal size={24} />}
          title="Sign in to approve CLI access."
          description="Enter the device code shown in your terminal after signing in."
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
    <AppPage
      className="accountPage"
      eyebrow="CLI device login"
      title="Approve CLI access"
      subtitle={`Signed in as @${auth.user.handle}. Approval creates a revocable registry API token.`}
    >
      <Card variant="panel" className="cliAuthPanel">
        <CardHeader title="Device login" icon={<Terminal size={16} />} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit("approve");
          }}
        >
          <Input
            label="Device code"
            value={userCode}
            onChange={(event) => setUserCode(event.target.value.toUpperCase())}
            placeholder="ABCD-2345"
            autoFocus
          />
          <div className="promptActions">
            <Button type="submit" iconStart={<CheckCircle2 size={15} />} loading={isWorking}>
              {isWorking ? "Approving" : "Approve"}
            </Button>
            <Button
              variant="secondary"
              iconStart={<XCircle size={15} />}
              disabled={isWorking}
              onClick={() => void submit("deny")}
            >
              Deny
            </Button>
          </div>
        </form>
        {notice ? (
          <Text className="formNotice" tone="muted">
            {notice}
          </Text>
        ) : null}
        {error ? (
          <Text className="formError" role="alert">
            {error}
          </Text>
        ) : null}
      </Card>
    </AppPage>
  );
}
