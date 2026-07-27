import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, Text } from "@gascity/ui";
import type {
  PublishRequestComment,
  PublishRequestStatus,
} from "../lib/api";

const terminalStatuses = new Set<PublishRequestStatus>(["approved", "rejected", "withdrawn"]);

export const publishCommentMaxLength = 4_000;

export type CommentMutationState =
  | { status: "idle" | "submitting" }
  | { status: "error"; message: string };

type ConversationDetail = {
  status: PublishRequestStatus;
  comments: PublishRequestComment[];
};

export function PublishConversation({
  id,
  label,
  detail,
  loading,
  error,
  onRetry,
  notice,
  introduction,
  focusCommentId,
  focusedComment,
  terminalText,
  composer,
}: {
  id?: string;
  label: string;
  detail: ConversationDetail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  notice?: ReactNode;
  introduction?: ReactNode;
  focusCommentId: string | null;
  focusedComment: RefObject<HTMLElement | null>;
  terminalText: string;
  composer: ReactNode;
}) {
  return (
    <section id={id} className="publishConversation" aria-label={label}>
      {loading && !detail ? (
        <Text role="status" aria-busy="true" tone="muted">Loading conversation…</Text>
      ) : null}
      {error ? (
        <p className="formError" role="alert">
          {error} <Button variant="ghost" size="sm" onClick={onRetry}>Retry conversation</Button>
        </p>
      ) : null}
      {detail ? (
        <>
          {notice}
          {introduction}
          <p>
            <strong>
              {detail.comments.length} {detail.comments.length === 1 ? "comment" : "comments"}
            </strong>
          </p>
          {detail.comments.length ? (
            <div className="publishComments">
              {detail.comments.map((comment) => (
                <Comment
                  key={comment.id}
                  comment={comment}
                  focusRef={comment.id === focusCommentId ? focusedComment : undefined}
                />
              ))}
            </div>
          ) : (
            <Text role="status" tone="muted">No comments yet.</Text>
          )}
          {terminalStatuses.has(detail.status) ? <Text tone="muted">{terminalText}</Text> : composer}
        </>
      ) : null}
    </section>
  );
}

export function CommentComposer({
  id,
  label,
  value,
  mutation,
  submitLabel,
  className,
  children,
  onChange,
  onSubmit,
}: {
  id: string;
  label: string;
  value: string;
  mutation: CommentMutationState;
  submitLabel: string;
  className?: string;
  children?: ReactNode;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const count = unicodeLength(value);
  return (
    <form className={`publishReplyForm${className ? ` ${className}` : ""}`} onSubmit={onSubmit}>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        value={value}
        disabled={mutation.status === "submitting"}
        aria-invalid={count > publishCommentMaxLength}
        onChange={(event) => onChange(event.target.value)}
      />
      <Text
        as="span"
        className={count > publishCommentMaxLength ? "formError" : undefined}
        tone="muted"
      >
        {publishCommentMaxLength - count} characters remaining
      </Text>
      {children}
      {mutation.status === "error" ? (
        <p className="formError" role="alert">{mutation.message}</p>
      ) : null}
      <Button
        type="submit"
        loading={mutation.status === "submitting"}
        disabled={!value.trim() || count > publishCommentMaxLength}
      >
        {submitLabel}
      </Button>
    </form>
  );
}

export function useCommentFocus(comments: PublishRequestComment[] | undefined) {
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const focusedComment = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!focusCommentId || !comments?.some(({ id }) => id === focusCommentId)) return;
    window.requestAnimationFrame(() => {
      focusedComment.current?.focus();
      setFocusCommentId(null);
    });
  }, [comments, focusCommentId]);

  return { focusCommentId, focusedComment, setFocusCommentId };
}

export function unicodeLength(value: string) {
  return Array.from(value).length;
}

export function isAbortError(reason: unknown) {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function Comment({
  comment,
  focusRef,
}: {
  comment: PublishRequestComment;
  focusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <article className="publishComment" ref={focusRef} tabIndex={-1}>
      <div>
        <strong>@{comment.authorHandle}</strong>
        <span>{comment.authorRole === "registry" ? "Registry" : "Submitter"}</span>
        <time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>
      </div>
      <p>{comment.body}</p>
    </article>
  );
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
