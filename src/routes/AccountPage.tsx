import {
  CheckCircle2,
  Copy,
  GitCommitHorizontal,
  GitPullRequest,
  KeyRound,
  RefreshCw,
  Save,
  Star,
  Trash2,
  UserRound,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import {
  apiRequest,
  type ApiTokenCreateResult,
  type ApiTokenRow,
  type AuthState,
  type PublishRequestRow,
  type ReviewRow,
} from "../lib/api";

export function AccountPage({
  auth,
  signIn,
  devSignIn,
  onProfileSaved,
}: {
  auth: AuthState;
  signIn: () => void;
  devSignIn: () => void;
  onProfileSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [publishRequests, setPublishRequests] = useState<PublishRequestRow[]>([]);
  const [apiTokens, setApiTokens] = useState<ApiTokenRow[]>([]);
  const [tokenLabel, setTokenLabel] = useState("GC CLI token");
  const [createdToken, setCreatedToken] = useState<ApiTokenCreateResult | null>(null);
  const [workingRequestId, setWorkingRequestId] = useState<string | null>(null);
  const [workingTokenId, setWorkingTokenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenNotice, setTokenNotice] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(auth.user?.displayName ?? "");
    setHandle(auth.user?.handle ?? "");
  }, [auth.user]);

  useEffect(() => {
    if (!auth.user || !auth.csrfToken) return;
    void apiRequest<{ reviews: ReviewRow[] }>("/api/account/reviews", {}, auth.csrfToken)
      .then((result) => setReviews(result.reviews))
      .catch(() => setReviews([]));
    void apiRequest<{ publishRequests: PublishRequestRow[] }>(
      "/api/account/publish-requests",
      {},
      auth.csrfToken,
    )
      .then((result) => setPublishRequests(result.publishRequests))
      .catch(() => setPublishRequests([]));
    void apiRequest<{ tokens: ApiTokenRow[] }>("/api/account/api-tokens", {}, auth.csrfToken)
      .then((result) => setApiTokens(result.tokens))
      .catch(() => setApiTokens([]));
  }, [auth.user, auth.csrfToken]);

  if (!auth.user) {
    return (
      <main className="accountPage">
        <section className="signInPromptInline large">
          <UserRound size={24} />
          <strong>Sign in to manage your registry account.</strong>
          <p>Your account stores reviews, saved packs, and profile display details.</p>
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

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setNotice(null);
    setError(null);
    try {
      await apiRequest(
        "/api/account/profile",
        {
          method: "PUT",
          body: JSON.stringify({ displayName, handle }),
        },
        auth.csrfToken,
      );
      setNotice("Profile saved.");
      onProfileSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save profile.");
    }
  };

  const refreshPublishRequests = async () => {
    if (!auth.csrfToken) return;
    const result = await apiRequest<{ publishRequests: PublishRequestRow[] }>(
      "/api/account/publish-requests",
      {},
      auth.csrfToken,
    );
    setPublishRequests(result.publishRequests);
  };

  const refreshApiTokens = async () => {
    if (!auth.csrfToken) return;
    const result = await apiRequest<{ tokens: ApiTokenRow[] }>(
      "/api/account/api-tokens",
      {},
      auth.csrfToken,
    );
    setApiTokens(result.tokens);
  };

  const createApiToken = async (event: React.FormEvent) => {
    event.preventDefault();
    setTokenNotice(null);
    setTokenError(null);
    setCreatedToken(null);
    setWorkingTokenId("new");
    try {
      const result = await apiRequest<{ token: ApiTokenCreateResult }>(
        "/api/account/api-tokens",
        {
          method: "POST",
          body: JSON.stringify({ label: tokenLabel }),
        },
        auth.csrfToken,
      );
      setCreatedToken(result.token);
      await refreshApiTokens();
      setTokenNotice("API token created.");
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Unable to create API token.");
    } finally {
      setWorkingTokenId(null);
    }
  };

  const revokeApiToken = async (id: string) => {
    setTokenNotice(null);
    setTokenError(null);
    setWorkingTokenId(id);
    try {
      await apiRequest(
        `/api/account/api-tokens/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        auth.csrfToken,
      );
      await refreshApiTokens();
      setTokenNotice("API token revoked.");
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Unable to revoke API token.");
    } finally {
      setWorkingTokenId(null);
    }
  };

  const validatePublishRequest = async (id: string) => {
    setNotice(null);
    setError(null);
    setWorkingRequestId(id);
    try {
      const result = await apiRequest<{ publishRequest: PublishRequestRow }>(
        `/api/publish-requests/${encodeURIComponent(id)}/validate`,
        { method: "POST" },
        auth.csrfToken,
      );
      setPublishRequests((requests) =>
        requests.map((request) => (request.id === id ? result.publishRequest : request)),
      );
      setNotice(
        result.publishRequest.status === "pending_review"
          ? "Publish request validated and queued for review."
          : "Publish request validation finished.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to validate publish request.");
      await refreshPublishRequests().catch(() => {});
    } finally {
      setWorkingRequestId(null);
    }
  };

  return (
    <main className="accountPage">
      <header className="accountHeader">
        <p className="eyebrow">Account</p>
        <h1>Registry profile</h1>
        <p>Persistent registry state is keyed to your Gas City account identity.</p>
      </header>

      <div className="accountGrid">
        <section className="accountPanel">
          <h2>Profile</h2>
          <form onSubmit={(event) => void saveProfile(event)}>
            <label>
              <span>Handle</span>
              <input value={handle} onChange={(event) => setHandle(event.target.value)} />
            </label>
            <label>
              <span>Display name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </label>
            <button className="iconTextButton primary" type="submit">
              <Save size={15} />
              Save profile
            </button>
          </form>
          {notice ? <p className="formNotice">{notice}</p> : null}
          {error ? <p className="formError" role="alert">{error}</p> : null}
        </section>

        <section className="accountPanel">
          <h2>API tokens</h2>
          <form onSubmit={(event) => void createApiToken(event)}>
            <label>
              <span>Label</span>
              <input value={tokenLabel} onChange={(event) => setTokenLabel(event.target.value)} />
            </label>
            <button
              className="iconTextButton primary"
              type="submit"
              disabled={workingTokenId === "new"}
            >
              <KeyRound size={15} />
              {workingTokenId === "new" ? "Creating" : "Create token"}
            </button>
          </form>
          {createdToken ? (
            <div className="tokenReveal">
              <span>
                Use this token with <code>GC_REGISTRY_TOKEN</code> or{" "}
                <code>gc registry publish --token</code>.
              </span>
              <code>{createdToken.token}</code>
              <button
                className="smallMutedButton"
                type="button"
                onClick={() => void navigator.clipboard.writeText(createdToken.token)}
              >
                <Copy size={14} />
                Copy
              </button>
            </div>
          ) : null}
          {tokenNotice ? <p className="formNotice">{tokenNotice}</p> : null}
          {tokenError ? <p className="formError" role="alert">{tokenError}</p> : null}
          {apiTokens.length === 0 ? (
            <p className="mutedText">No API tokens yet.</p>
          ) : (
            <div className="accountTokenList">
              {apiTokens.map((token) => (
                <article key={token.id}>
                  <div className="requestTitle">
                    <strong>{token.label}</strong>
                    <span className={`requestStatus ${token.revokedAt ? "rejected" : "approved"}`}>
                      {token.revokedAt ? "Revoked" : "Active"}
                    </span>
                  </div>
                  <span>
                    <KeyRound size={13} /> {token.prefix}...
                  </span>
                  <span>Created {formatDate(token.createdAt)}</span>
                  {token.lastUsedAt ? <span>Last used {formatDate(token.lastUsedAt)}</span> : null}
                  {!token.revokedAt ? (
                    <button
                      className="smallMutedButton"
                      type="button"
                      disabled={workingTokenId === token.id}
                      onClick={() => void revokeApiToken(token.id)}
                    >
                      <Trash2 size={14} />
                      {workingTokenId === token.id ? "Revoking" : "Revoke"}
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="accountPanel">
          <h2>My reviews</h2>
          {reviews.length === 0 ? (
            <p className="mutedText">No reviews yet.</p>
          ) : (
            <div className="accountReviewList">
              {reviews.map((review) => (
                <article key={review.id}>
                  <strong>{review.title || review.packKey}</strong>
                  <span>
                    <Star size={13} fill="currentColor" /> {review.rating} · {review.packKey}
                  </span>
                  <p>{review.body}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="accountPanel">
          <h2>Publish requests</h2>
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
                  {request.registryEntry ? (
                    <div className="requestPreview">
                      <span>
                        <CheckCircle2 size={13} /> {request.registryEntry.release.hash}
                      </span>
                      <p>{request.registryEntry.description}</p>
                    </div>
                  ) : null}
                  {request.status === "pending_validation" || request.status === "validation_failed" ? (
                    <button
                      className="smallMutedButton"
                      type="button"
                      disabled={workingRequestId === request.id}
                      onClick={() => void validatePublishRequest(request.id)}
                    >
                      <RefreshCw size={14} />
                      {workingRequestId === request.id ? "Validating" : "Validate"}
                    </button>
                  ) : null}
                  {request.statusReason ? <p>{request.statusReason}</p> : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
