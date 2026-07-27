import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@gascity/ui";
import {
  addAdminPublishRequestComment,
  getAdminPublishRequestFeedback,
  type PublishRequestActionOwner,
  type PublishRequestRow,
  type StaffPublishRequestFeedbackDetail,
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

export function AdminPublishConversation({
  request,
  csrfToken,
}: {
  request: PublishRequestRow;
  csrfToken: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<StaffPublishRequestFeedbackDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [actionRequiredBy, setActionRequiredBy] = useState<PublishRequestActionOwner>("registry");
  const [mutation, setMutation] = useState<CommentMutationState>({ status: "idle" });
  const { focusCommentId, focusedComment, setFocusCommentId } =
    useCommentFocus(detail?.comments);

  async function loadDetail(signal?: AbortSignal) {
    setLoading(true);
    setLoadError(null);
    try {
      const next = (await getAdminPublishRequestFeedback(request.id, signal)).publishRequest;
      if (signal?.aborted) return null;
      setDetail(next);
      setActionRequiredBy(next.actionRequiredBy ?? "registry");
      return next;
    } catch (reason) {
      if (!isAbortError(reason)) {
        setLoadError(reason instanceof Error ? reason.message : "Unable to load the conversation.");
      }
      return null;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    void loadDetail(controller.signal);
    return () => controller.abort();
    // A queue mutation changes updatedAt and refreshes an open conversation once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request.updatedAt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !csrfToken ||
      !body.trim() ||
      unicodeLength(body) > publishCommentMaxLength
    ) return;
    setMutation({ status: "submitting" });
    try {
      const created = await addAdminPublishRequestComment(
        request.id,
        body,
        actionRequiredBy,
        csrfToken,
      );
      setBody("");
      const refreshed = await loadDetail();
      if (!refreshed) throw new Error("Comment saved, but the conversation could not be refreshed.");
      setFocusCommentId(created.comment.id);
      setMutation({ status: "idle" });
    } catch (reason) {
      setMutation({
        status: "error",
        message: reason instanceof Error ? reason.message : "Unable to add staff comment.",
      });
    }
  }

  const label = `${request.requestedName} ${request.requestedVersion}`;
  return (
    <section className="adminPublishConversation" aria-label={`Feedback for ${label}`}>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={`admin-conversation-${request.id}`}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? `Close conversation for ${label}` : `Open conversation for ${label}`}
      </Button>
      {open ? (
        <PublishConversation
          id={`admin-conversation-${request.id}`}
          label={`Conversation for ${label}`}
          detail={detail}
          loading={loading}
          error={loadError}
          onRetry={() => void loadDetail()}
          introduction={
            detail ? (
              <p><strong>What happens next:</strong> {publishRequestNextStepText(detail.nextStep)}</p>
            ) : null
          }
          focusCommentId={focusCommentId}
          focusedComment={focusedComment}
          terminalText="This request is terminal and cannot receive comments."
          composer={
            <CommentComposer
              id={`admin-comment-${request.id}`}
              label={`Staff comment for ${label}`}
              value={body}
              mutation={mutation}
              submitLabel={`Send comment for ${label}`}
              className="adminCommentForm"
              onChange={setBody}
              onSubmit={(event) => void submit(event)}
            >
              <label htmlFor={`admin-next-${request.id}`}>Next action for {label}</label>
              <select
                id={`admin-next-${request.id}`}
                className="gc-input"
                value={actionRequiredBy}
                disabled={mutation.status === "submitting"}
                onChange={(event) =>
                  setActionRequiredBy(event.target.value as PublishRequestActionOwner)}
              >
                <option value="registry">Registry staff</option>
                <option value="submitter">Submitter</option>
              </select>
            </CommentComposer>
          }
        />
      ) : null}
    </section>
  );
}
