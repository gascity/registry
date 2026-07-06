import {
  CheckCircle2,
  GitCommitHorizontal,
  GitPullRequest,
  RefreshCw,
  ShieldCheck,
  UserRound,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  AppPage,
  Badge,
  Button,
  Card,
  EmptyState,
  Text,
} from "@gascity/ui";
import { apiRequest, type AuthState, type PublishRequestRow } from "../lib/api";

export function AdminPublishPage({
  auth,
  signIn,
  devSignIn,
}: {
  auth: AuthState;
  signIn: () => void;
  devSignIn: () => void;
}) {
  const [publishRequests, setPublishRequests] = useState<PublishRequestRow[]>([]);
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [withdrawReasons, setWithdrawReasons] = useState<Record<string, string>>({});
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({});
  const [workingRequestId, setWorkingRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canReview = auth.user?.role === "admin" || auth.user?.role === "moderator";

  useEffect(() => {
    if (!auth.user || !auth.csrfToken || !canReview) return;
    void refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.user, auth.csrfToken, canReview]);

  if (!auth.user) {
    return (
      <div className="accountPage">
        <EmptyState
          className="signInPromptInline large"
          icon={<UserRound size={24} />}
          title="Sign in to review publish requests."
          description="Registry staff can validate, approve, and reject direct publish requests."
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

  if (!canReview) {
    return (
      <div className="accountPage">
        <EmptyState
          className="signInPromptInline large"
          icon={<ShieldCheck size={24} />}
          title="Registry staff access required."
          description="This queue is limited to registry moderators and admins."
        />
      </div>
    );
  }

  async function refreshQueue() {
    if (!auth.csrfToken) return;
    try {
      const result = await apiRequest<{ publishRequests: PublishRequestRow[] }>(
        "/api/admin/publish-requests",
        {},
        auth.csrfToken,
      );
      setPublishRequests(result.publishRequests);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load publish requests.");
    }
  }

  async function runAction(
    request: PublishRequestRow,
    action: "validate" | "approve" | "reject" | "withdraw",
  ) {
    if (!auth.csrfToken) return;
    setWorkingRequestId(request.id);
    setError(null);
    try {
      const overrideReason = overrideReasons[request.id]?.trim();
      const body =
        action === "reject"
          ? JSON.stringify({ reason: rejectReasons[request.id] ?? "" })
          : action === "withdraw"
            ? JSON.stringify({ reason: withdrawReasons[request.id] ?? "" })
            : action === "approve" && overrideReason
              ? JSON.stringify({ ownershipOverrideReason: overrideReason })
              : undefined;
      const result = await apiRequest<{ publishRequest: PublishRequestRow }>(
        `/api/publish-requests/${encodeURIComponent(request.id)}/${action}`,
        { method: "POST", body },
        auth.csrfToken,
      );
      setPublishRequests((requests) =>
        requests.map((candidate) =>
          candidate.id === request.id ? result.publishRequest : candidate,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : `Unable to ${action} request.`;
      // Resync the queue, THEN surface the error: refreshQueue() clears the error on a
      // successful reload, so setting it afterwards keeps the actionable message (e.g. the
      // ownership gate's 403) visible instead of letting it flash and vanish.
      await refreshQueue();
      setError(message);
    } finally {
      setWorkingRequestId(null);
    }
  }

  return (
    <AppPage
      className="accountPage"
      eyebrow="Review"
      title="Publish requests"
      subtitle="Validate upstream GitHub packs, then approve releases into the synthetic aggregate."
    >
      {error ? (
        <Text className="formError" role="alert">
          {error}
        </Text>
      ) : null}

      <Card className="accountPanel">
        {publishRequests.length === 0 ? (
          <Text className="mutedText" tone="muted">
            No publish requests yet.
          </Text>
        ) : (
          <div className="accountRequestList">
            {publishRequests.map((request) => (
              <article key={request.id}>
                <div className="requestTitle">
                  <strong>
                    {request.requestedName} {request.requestedVersion}
                  </strong>
                  <Badge status={statusStatus(request.status)}>
                    {statusLabel(request.status)}
                  </Badge>
                </div>
                <span>
                  <GitPullRequest size={13} /> {request.repository.fullName}
                  {request.packPath === "." ? "" : `/${request.packPath}`}
                </span>
                <span>
                  <GitCommitHorizontal size={13} /> {request.commit.slice(0, 12)}
                </span>
                <span>Submitted by {request.submittedBy.displayName || request.submittedBy.handle}</span>
                {request.registryEntry ? (
                  <div className="requestPreview">
                    <span>
                      <CheckCircle2 size={13} /> {request.registryEntry.release.hash}
                    </span>
                    <p>{request.registryEntry.description}</p>
                  </div>
                ) : null}
                {request.statusReason ? <p>{request.statusReason}</p> : null}
                <div className="requestActions">
                  {(request.status === "pending_validation" ||
                    request.status === "validation_failed") ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconStart={<RefreshCw size={14} />}
                      disabled={workingRequestId === request.id}
                      onClick={() => void runAction(request, "validate")}
                    >
                      Validate
                    </Button>
                  ) : null}
                  {request.status === "pending_review" ? (
                    <>
                      {needsOwnershipOverride(request) ? (
                        <input
                          className="gc-input"
                          aria-label={`Ownership override reason for ${request.requestedName}`}
                          placeholder="Ownership override reason"
                          value={overrideReasons[request.id] ?? ""}
                          onChange={(event) =>
                            setOverrideReasons((reasons) => ({
                              ...reasons,
                              [request.id]: event.target.value,
                            }))
                          }
                        />
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        iconStart={<CheckCircle2 size={14} />}
                        disabled={workingRequestId === request.id}
                        onClick={() => void runAction(request, "approve")}
                      >
                        Approve
                      </Button>
                    </>
                  ) : null}
                  {/* Reject is only offered on pre-approval states, matching the server guard
                      (rejectPublishRequest rejects only pending_validation | validation_failed |
                      pending_review). An approved release is taken down via Withdraw, not Reject;
                      terminal rejected/withdrawn rows offer nothing. */}
                  {request.status === "pending_validation" ||
                  request.status === "validation_failed" ||
                  request.status === "pending_review" ? (
                    <>
                      {/* Inline action-row field: the kit <Input> always renders a
                          visible uppercase label, which doesn't fit this 3-up grid.
                          Reuse the kit input styling (gc-input) and keep the exact
                          accessible name the original carried. */}
                      <input
                        className="gc-input"
                        aria-label={`Reject reason for ${request.requestedName}`}
                        placeholder="Reason"
                        value={rejectReasons[request.id] ?? ""}
                        onChange={(event) =>
                          setRejectReasons((reasons) => ({
                            ...reasons,
                            [request.id]: event.target.value,
                          }))
                        }
                      />
                      <Button
                        variant="danger"
                        size="sm"
                        iconStart={<XCircle size={14} />}
                        disabled={workingRequestId === request.id}
                        onClick={() => void runAction(request, "reject")}
                      >
                        Reject
                      </Button>
                    </>
                  ) : null}
                  {request.status === "approved" ? (
                    <>
                      <input
                        className="gc-input"
                        aria-label={`Withdraw reason for ${request.requestedName}`}
                        placeholder="Takedown reason"
                        value={withdrawReasons[request.id] ?? ""}
                        onChange={(event) =>
                          setWithdrawReasons((reasons) => ({
                            ...reasons,
                            [request.id]: event.target.value,
                          }))
                        }
                      />
                      <Button
                        variant="danger"
                        size="sm"
                        iconStart={<XCircle size={14} />}
                        disabled={workingRequestId === request.id}
                        onClick={() => void runAction(request, "withdraw")}
                      >
                        Withdraw
                      </Button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>
    </AppPage>
  );
}

function needsOwnershipOverride(request: PublishRequestRow) {
  // Repo-proven submissions (GitHub Actions OIDC / GitHub import) clear the source-repo
  // ownership gate on their own. Claim-only submissions (web form / API token) need a
  // verified ownership record or an audited staff override to be approvable, so offer the
  // override field. Unknown methods are treated as claim-only, matching the server gate.
  return (
    request.submissionMethod !== "github_actions_oidc" &&
    request.submissionMethod !== "github_import"
  );
}

function statusLabel(status: PublishRequestRow["status"]) {
  switch (status) {
    case "pending_validation":
      return "Pending validation";
    case "validation_failed":
      return "Validation failed";
    case "pending_review":
      return "Pending review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "withdrawn":
      return "Withdrawn";
  }
}

function statusStatus(status: PublishRequestRow["status"]) {
  switch (status) {
    case "approved":
      return "success" as const;
    case "rejected":
    case "validation_failed":
      return "danger" as const;
    case "withdrawn":
      return "warn" as const;
    default:
      return "info" as const;
  }
}
