import { GitCommitHorizontal, GitPullRequest, RefreshCw } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, CardHeader, Text } from "@gascity/ui";
import {
  getPublishRequestFeedback,
  listPublishRequestFeedback,
  markPublishRequestFeedbackRead,
  replyToPublishRequestFeedback,
  type PublishRequestFeedbackDetail,
  type PublishRequestFeedbackList,
  type PublishRequestFeedbackSummary,
} from "../lib/api";
import { publishRequestNextStepText } from "../lib/publishRequestPresentation";
import {
  CommentComposer,
  type CommentMutationState,
  isAbortError,
  PublishConversation,
  publishCommentMaxLength,
  unicodeLength,
  useCommentFocus,
} from "./PublishConversation";

export function PublishFeedbackPanel({
  csrfToken,
  validatingRequestId,
  validationNotice,
  validationError,
  onValidate,
}: {
  csrfToken: string | null;
  validatingRequestId: string | null;
  validationNotice: string | null;
  validationError: string | null;
  onValidate: (id: string) => Promise<void>;
}) {
  const [list, setList] = useState<PublishRequestFeedbackList | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<PublishRequestFeedbackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [readError, setReadError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [mutation, setMutation] = useState<CommentMutationState>({ status: "idle" });
  const { focusCommentId, focusedComment, setFocusCommentId } =
    useCommentFocus(detail?.comments);

  async function loadSummaries(signal?: AbortSignal, showLoading = false) {
    if (!csrfToken) return;
    if (showLoading) setListLoading(true);
    setListError(null);
    try {
      setList(await listPublishRequestFeedback(csrfToken, signal));
    } catch (reason) {
      if (isAbortError(reason)) return;
      setListError(reason instanceof Error ? reason.message : "Unable to load publish requests.");
    } finally {
      if (showLoading) setListLoading(false);
    }
  }

  async function loadDetail(id: string, signal?: AbortSignal) {
    if (!csrfToken) return;
    setDetailLoading(true);
    setDetailError(null);
    setReadError(null);
    try {
      const next = (await getPublishRequestFeedback(id, csrfToken, signal)).publishRequest;
      if (signal?.aborted) return;
      setDetail(next);
      if (next.submitterUnreadAt) {
        try {
          await markPublishRequestFeedbackRead(id, next.submitterUnreadAt, csrfToken);
          await loadSummaries();
        } catch (reason) {
          if (!isAbortError(reason)) {
            setReadError(reason instanceof Error ? reason.message : "Unable to mark feedback read.");
          }
        }
      }
    } catch (reason) {
      if (!isAbortError(reason)) {
        setDetailError(reason instanceof Error ? reason.message : "Unable to load the conversation.");
      }
    } finally {
      if (!signal?.aborted) setDetailLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadSummaries(controller.signal, true);
    return () => controller.abort();
    // The token is the lifetime of this account view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csrfToken]);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setReadError(null);
    setReply("");
    setMutation({ status: "idle" });
    setFocusCommentId(null);
    if (!selectedId) return;
    const controller = new AbortController();
    void loadDetail(selectedId, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, detailReload]);

  async function submitReply(event: FormEvent) {
    event.preventDefault();
    if (
      !csrfToken ||
      !detail ||
      !reply.trim() ||
      unicodeLength(reply) > publishCommentMaxLength
    ) return;
    const requestId = detail.id;
    setMutation({ status: "submitting" });
    try {
      const created = await replyToPublishRequestFeedback(requestId, reply, csrfToken);
      if (selectedIdRef.current !== requestId) {
        await loadSummaries();
        return;
      }
      setReply("");
      const refreshed = (await getPublishRequestFeedback(requestId, csrfToken)).publishRequest;
      if (selectedIdRef.current !== requestId) {
        await loadSummaries();
        return;
      }
      setFocusCommentId(created.comment.id);
      setDetail(refreshed);
      if (refreshed.submitterUnreadAt) {
        await markPublishRequestFeedbackRead(requestId, refreshed.submitterUnreadAt, csrfToken);
      }
      await loadSummaries();
      if (selectedIdRef.current === requestId) setMutation({ status: "idle" });
    } catch (reason) {
      if (selectedIdRef.current !== requestId) return;
      setMutation({
        status: "error",
        message: reason instanceof Error ? reason.message : "Unable to send reply.",
      });
    }
  }

  return (
    <Card className="accountPanel publishFeedbackPanel">
      <CardHeader
        title={
          <h2 className="cardTitleHeading">
            Publish requests{list?.unreadCount ? ` (${list.unreadCount} unread)` : ""}
          </h2>
        }
        icon={<GitPullRequest size={16} />}
      />
      {validationNotice ? <p className="formNotice" role="status">{validationNotice}</p> : null}
      {validationError ? <p className="formError" role="alert">{validationError}</p> : null}
      {listError ? (
        <p className="formError" role="alert">
          {listError}{" "}
          <Button variant="ghost" size="sm" onClick={() => void loadSummaries(undefined, true)}>
            Retry publish requests
          </Button>
        </p>
      ) : null}
      {listLoading && !list ? (
        <Text role="status" aria-busy="true" tone="muted">Loading publish requests…</Text>
      ) : null}
      {!listLoading && !listError && list?.publishRequests.length === 0 ? (
        <Text tone="muted">No publish requests yet.</Text>
      ) : null}
      {list?.publishRequests.length ? (
        <div className="accountRequestList" aria-busy={listLoading}>
          {list.publishRequests.map((request) => {
            const open = selectedId === request.id;
            const label = `${request.requestedName} ${request.requestedVersion}`;
            const conversationId = `publish-conversation-${encodeURIComponent(request.id)}`;
            return (
              <article key={request.id} aria-label={label}>
                <div className="requestTitle">
                  <strong>{label}</strong>
                  <Badge status={statusTone(request.status)}>{statusLabel(request.status)}</Badge>
                </div>
                {request.unread ? <span className="publishFeedbackUnread">Unread</span> : null}
                <span>
                  <GitPullRequest size={13} /> {request.repository.fullName}
                  {request.packPath === "." ? "" : `/${request.packPath}`}
                </span>
                <span><GitCommitHorizontal size={13} /> {request.commit.slice(0, 12)}</span>
                <p><strong>What happens next:</strong> {publishRequestNextStepText(request.nextStep)}</p>
                {request.statusReason ? <p>{request.statusReason}</p> : null}
                <div className="requestActions">
                  <Button
                    className="publishConversationToggle"
                    variant="ghost"
                    size="sm"
                    aria-expanded={open}
                    aria-controls={conversationId}
                    onClick={() => {
                      const nextId = open ? null : request.id;
                      selectedIdRef.current = nextId;
                      setSelectedId(nextId);
                    }}
                  >
                    {open ? `Close conversation for ${label}` : `Open conversation for ${label}`}
                  </Button>
                  {request.status === "pending_validation" || request.status === "validation_failed" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconStart={<RefreshCw size={14} />}
                      loading={validatingRequestId === request.id}
                      onClick={() => void onValidate(request.id).then(() => loadSummaries())}
                    >
                      {validatingRequestId === request.id ? "Validating" : "Validate"}
                    </Button>
                  ) : null}
                </div>
                {open ? (
                  <PublishConversation
                    id={conversationId}
                    label={`Conversation for ${label}`}
                    detail={detail?.id === request.id ? detail : null}
                    loading={detailLoading}
                    error={detailError}
                    notice={readError ? <p className="formError" role="alert">{readError}</p> : null}
                    focusedComment={focusedComment}
                    focusCommentId={focusCommentId}
                    onRetry={() => setDetailReload((value) => value + 1)}
                    terminalText="This request is terminal and cannot receive replies."
                    composer={
                      <CommentComposer
                        id={`publish-reply-${request.id}`}
                        label={`Reply to ${label}`}
                        value={reply}
                        mutation={mutation}
                        submitLabel="Send reply"
                        onChange={setReply}
                        onSubmit={(event) => void submitReply(event)}
                      />
                    }
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </Card>
  );
}

function statusLabel(status: PublishRequestFeedbackSummary["status"]) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(status: PublishRequestFeedbackSummary["status"]) {
  if (status === "approved") return "success" as const;
  if (status === "rejected" || status === "validation_failed") return "danger" as const;
  if (status === "withdrawn") return "warn" as const;
  return "info" as const;
}
