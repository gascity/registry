import {
  ArrowRightLeft,
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
import { ApiError, apiRequest, type AuthState, type PublishRequestRow } from "../lib/api";
import { nameClaimReleaseBlocker } from "../lib/packName";
import { PublishRequestGuidance } from "../components/PublishRequestGuidance";

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
  // The two consequential name levers. Both are opt-in per row and both start closed: a re-pin
  // MOVES a name onto a different repository and a release UNCLAIMS one, so neither may be
  // reachable by mis-clicking the ordinary Approve/Withdraw button.
  const [namePinReasons, setNamePinReasons] = useState<Record<string, string>>({});
  const [namePinConfirms, setNamePinConfirms] = useState<Record<string, string>>({});
  // Set only after the server has refused an approve with PUBLISH_NAME_OWNER_MISMATCH, so the
  // re-pin block can never appear before staff have been told which repository holds the name.
  const [namePinBlocked, setNamePinBlocked] = useState<Record<string, boolean>>({});
  const [releaseNameClaims, setReleaseNameClaims] = useState<Record<string, boolean>>({});
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

  // `repin` and `unclaim` are the plain approve/withdraw calls plus exactly one extra field. They
  // are separate intents rather than extra state on the plain buttons so that an ordinary Approve
  // can never send namePinOverrideReason and an ordinary Withdraw can never send releaseNameClaim,
  // no matter what is typed into the row.
  async function runAction(
    request: PublishRequestRow,
    action: "validate" | "approve" | "reject" | "withdraw" | "repin" | "unclaim",
  ) {
    if (!auth.csrfToken) return;
    const endpoint =
      action === "repin" ? "approve" : action === "unclaim" ? "withdraw" : action;
    setWorkingRequestId(request.id);
    setError(null);
    try {
      const overrideReason = overrideReasons[request.id]?.trim();
      const body = requestBodyFor(action, request, overrideReason);
      const result = await apiRequest<{ publishRequest: PublishRequestRow }>(
        `/api/publish-requests/${encodeURIComponent(request.id)}/${endpoint}`,
        { method: "POST", body },
        auth.csrfToken,
      );
      setPublishRequests((requests) =>
        requests.map((candidate) =>
          candidate.id === request.id ? result.publishRequest : candidate,
        ),
      );
      if (action === "repin") clearNamePinPrompt(request.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : `Unable to ${endpoint} request.`;
      // The name is claimed by another repository. Reveal the re-pin lever for THIS row only —
      // the refusal message (which names the claiming repository) stays on screen beside it, so
      // staff always learn what they would be taking the name away from before they can do it.
      // Deliberately not fired for a 409 CONFLICT: that one means "the claim moved under you,
      // retry", not "re-pin".
      if (err instanceof ApiError && err.code === "PUBLISH_NAME_OWNER_MISMATCH") {
        setNamePinBlocked((blocked) => ({ ...blocked, [request.id]: true }));
      }
      // Resync the queue, THEN surface the error: refreshQueue() clears the error on a
      // successful reload, so setting it afterwards keeps the actionable message (e.g. the
      // ownership gate's 403) visible instead of letting it flash and vanish.
      await refreshQueue();
      setError(message);
    } finally {
      setWorkingRequestId(null);
    }
  }

  function requestBodyFor(
    action: "validate" | "approve" | "reject" | "withdraw" | "repin" | "unclaim",
    request: PublishRequestRow,
    overrideReason: string | undefined,
  ) {
    switch (action) {
      case "reject":
        return JSON.stringify({ reason: rejectReasons[request.id] ?? "" });
      case "withdraw":
        return JSON.stringify({ reason: withdrawReasons[request.id] ?? "" });
      case "unclaim":
        return JSON.stringify({
          reason: withdrawReasons[request.id] ?? "",
          releaseNameClaim: true,
        });
      case "repin":
        return JSON.stringify({
          ...(overrideReason ? { ownershipOverrideReason: overrideReason } : {}),
          namePinOverrideReason: namePinReasons[request.id]?.trim() ?? "",
        });
      case "approve":
        return overrideReason ? JSON.stringify({ ownershipOverrideReason: overrideReason }) : undefined;
      default:
        return undefined;
    }
  }

  function clearNamePinPrompt(id: string) {
    setNamePinBlocked((blocked) => ({ ...blocked, [id]: false }));
    setNamePinReasons((reasons) => ({ ...reasons, [id]: "" }));
    setNamePinConfirms((confirms) => ({ ...confirms, [id]: "" }));
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
                <PublishRequestGuidance request={request} audience="staff" />
                {request.registryEntry ? (
                  <div className="requestPreview">
                    <span>
                      <CheckCircle2 size={13} /> {request.registryEntry.release.hash}
                    </span>
                    <p>{request.registryEntry.description}</p>
                  </div>
                ) : null}
                {request.validationError ? (
                  <p className="formError">Validation: {request.validationError}</p>
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
                        onClick={() =>
                          void runAction(
                            request,
                            releasingNameClaim(request, publishRequests, releaseNameClaims)
                              ? "unclaim"
                              : "withdraw",
                          )
                        }
                      >
                        {releasingNameClaim(request, publishRequests, releaseNameClaims)
                          ? "Withdraw and unclaim"
                          : "Withdraw"}
                      </Button>
                    </>
                  ) : null}
                </div>
                {/* The two consequential name levers live BELOW the action grid, each with the
                    consequence spelled out in full. Both are opt-in, and both are built only from
                    data this component already holds — no message parsing, no extra endpoint. */}
                {request.status === "approved" ? (
                  <div className="requestLever">
                    {releaseNameClaimExplanation(request, publishRequests) ?? (
                      <>
                        <label className="requestLeverToggle">
                          <input
                            type="checkbox"
                            aria-label={`Release the name claim for ${request.requestedName}`}
                            checked={releaseNameClaims[request.id] ?? false}
                            onChange={(event) =>
                              setReleaseNameClaims((flags) => ({
                                ...flags,
                                [request.id]: event.target.checked,
                              }))
                            }
                          />
                          <span>
                            Also release the name claim (frees <code>{request.requestedName}</code>{" "}
                            for another repository to claim)
                          </span>
                        </label>
                        {releaseNameClaims[request.id] ? (
                          <Text className="requestLeverWarning" tone="muted">
                            <code>{request.requestedName}</code> returns to unclaimed. The next
                            repository to publish it and get approved takes the name — this
                            takedown will not be reversible by re-approving.
                          </Text>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
                {request.status === "pending_review" && namePinBlocked[request.id] ? (
                  <div className="requestLever">
                    <strong>Re-pin the pack name</strong>
                    {/* Consequence in the concrete, from fields the row already carries. The
                        refusal above names the repository that currently holds the claim; this
                        says what approving anyway would do to it. */}
                    <Text className="requestLeverWarning" tone="muted">
                      Approving MOVES <code>{request.requestedName}</code> onto{" "}
                      <code>{request.repository.fullName}</code>. The repository named in the
                      refusal above loses it. Every future release of{" "}
                      <code>{request.requestedName}</code> must then come from{" "}
                      <code>{request.repository.fullName}</code>.
                    </Text>
                    <input
                      className="gc-input"
                      aria-label={`Name re-pin reason for ${request.requestedName}`}
                      placeholder="Why is this name moving? (e.g. repo migration, ticket #77)"
                      value={namePinReasons[request.id] ?? ""}
                      onChange={(event) =>
                        setNamePinReasons((reasons) => ({
                          ...reasons,
                          [request.id]: event.target.value,
                        }))
                      }
                    />
                    <input
                      className="gc-input"
                      aria-label={`Confirm pack name to re-pin ${request.requestedName}`}
                      placeholder={`Type ${request.requestedName} to confirm`}
                      value={namePinConfirms[request.id] ?? ""}
                      onChange={(event) =>
                        setNamePinConfirms((confirms) => ({
                          ...confirms,
                          [request.id]: event.target.value,
                        }))
                      }
                    />
                    <div className="requestLeverActions">
                      <Button
                        variant="danger"
                        size="sm"
                        iconStart={<ArrowRightLeft size={14} />}
                        disabled={
                          workingRequestId === request.id ||
                          !(namePinReasons[request.id] ?? "").trim() ||
                          (namePinConfirms[request.id] ?? "") !== request.requestedName
                        }
                        onClick={() => void runAction(request, "repin")}
                      >
                        Re-pin and approve
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={workingRequestId === request.id}
                        onClick={() => clearNamePinPrompt(request.id)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </Card>
    </AppPage>
  );
}

// Whether a takedown will also release the name claim: DERIVED from the blocker every render, not
// just remembered from the tick. A blocker can appear after the box is ticked — approving a sibling
// release is an ordinary next action in this same queue — and when it does, the explanation REPLACES
// the checkbox. A remembered flag would then leave the row's only takedown control still sending
// releaseNameClaim, 422ing on every click with no visible control to disarm it, and would later
// resurface pre-armed once the blocker cleared.
function releasingNameClaim(
  request: PublishRequestRow,
  queue: PublishRequestRow[],
  flags: Record<string, boolean>,
) {
  return (flags[request.id] ?? false) && !nameClaimReleaseBlocker(request, queue);
}

// The copy for each reason the release lever is withheld. The DECISION lives in
// nameClaimReleaseBlocker (src/lib/packName.ts) — pure and unit-tested per branch, because the
// unscoped case is not reachable through any API and a branch no test can kill silently rots.
function releaseNameClaimExplanation(request: PublishRequestRow, queue: PublishRequestRow[]) {
  switch (nameClaimReleaseBlocker(request, queue)) {
    case "unscoped_name_reserved":
      return (
        <Text className="requestLeverWarning" tone="muted">
          <code>{request.requestedName}</code> is unscoped. Unscoped names stay reserved, so this
          claim cannot be released — releasing it would make the name permanently unpublishable.
        </Text>
      );
    case "sibling_release_served":
      return (
        <Text className="requestLeverWarning" tone="muted">
          Another approved release of <code>{request.requestedName}</code> is still served. Release
          the claim only after the last one is withdrawn.
        </Text>
      );
    default:
      return null;
  }
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
