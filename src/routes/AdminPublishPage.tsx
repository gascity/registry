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
      <main className="accountPage">
        <section className="signInPromptInline large">
          <UserRound size={24} />
          <strong>Sign in to review publish requests.</strong>
          <p>Registry staff can validate, approve, and reject direct publish requests.</p>
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

  if (!canReview) {
    return (
      <main className="accountPage">
        <section className="signInPromptInline large">
          <ShieldCheck size={24} />
          <strong>Registry staff access required.</strong>
          <p>This queue is limited to registry moderators and admins.</p>
        </section>
      </main>
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
    action: "validate" | "approve" | "reject",
  ) {
    if (!auth.csrfToken) return;
    setWorkingRequestId(request.id);
    setError(null);
    try {
      const result = await apiRequest<{ publishRequest: PublishRequestRow }>(
        `/api/publish-requests/${encodeURIComponent(request.id)}/${action}`,
        {
          method: "POST",
          body:
            action === "reject"
              ? JSON.stringify({ reason: rejectReasons[request.id] ?? "" })
              : undefined,
        },
        auth.csrfToken,
      );
      setPublishRequests((requests) =>
        requests.map((candidate) =>
          candidate.id === request.id ? result.publishRequest : candidate,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to ${action} request.`);
      await refreshQueue();
    } finally {
      setWorkingRequestId(null);
    }
  }

  return (
    <main className="accountPage">
      <header className="accountHeader">
        <p className="eyebrow">Review</p>
        <h1>Publish requests</h1>
        <p>Validate upstream GitHub packs, then approve releases into the synthetic aggregate.</p>
      </header>

      {error ? <p className="formError" role="alert">{error}</p> : null}

      <section className="accountPanel">
        {publishRequests.length === 0 ? (
          <p className="mutedText">No publish requests yet.</p>
        ) : (
          <div className="accountRequestList">
            {publishRequests.map((request) => (
              <article key={request.id}>
                <div className="requestTitle">
                  <strong>
                    {request.requestedName} {request.requestedVersion}
                  </strong>
                  <span className={`requestStatus ${request.status}`}>
                    {statusLabel(request.status)}
                  </span>
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
                    <button
                      className="smallMutedButton"
                      type="button"
                      disabled={workingRequestId === request.id}
                      onClick={() => void runAction(request, "validate")}
                    >
                      <RefreshCw size={14} />
                      Validate
                    </button>
                  ) : null}
                  {request.status === "pending_review" ? (
                    <button
                      className="smallMutedButton"
                      type="button"
                      disabled={workingRequestId === request.id}
                      onClick={() => void runAction(request, "approve")}
                    >
                      <CheckCircle2 size={14} />
                      Approve
                    </button>
                  ) : null}
                  {request.status !== "approved" && request.status !== "rejected" ? (
                    <>
                      <input
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
                      <button
                        className="textDangerButton"
                        type="button"
                        disabled={workingRequestId === request.id}
                        onClick={() => void runAction(request, "reject")}
                      >
                        <XCircle size={14} />
                        Reject
                      </button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
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
  }
}
