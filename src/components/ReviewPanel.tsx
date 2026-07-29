import { Flag, Loader2, Pencil, Save, Star, ThumbsUp, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CardHeader, ErrorState, Input } from "@gascity/ui";
import {
  apiRequest,
  type AuthState,
  type PackOwnership,
  type ReviewInput,
  type ReviewListResult,
  type ReviewRow,
} from "../lib/api";
import type { CatalogPack } from "../lib/registry";

type ReviewPanelProps = {
  pack: CatalogPack;
  auth: AuthState;
  signIn: () => void;
  devSignIn: () => void;
  onReviewSummary?: (summary: ReviewListResult["summary"]) => void;
};

export function ReviewPanel({ pack, auth, signIn, devSignIn, onReviewSummary }: ReviewPanelProps) {
  const [state, setState] = useState<ReviewListResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [verifiedPublisherId, setVerifiedPublisherId] = useState<string | null>(null);

  const viewerReview = state?.viewerReview ?? null;
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [recommend, setRecommend] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<"edit" | "title" | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  const resetForm = () => {
    setRating(5);
    setTitle("");
    setBody("");
    setRecommend(true);
  };

  const startEditing = () => {
    if (!viewerReview || isSubmitting) return;
    setRating(viewerReview.rating);
    setTitle(viewerReview.title ?? "");
    setBody(viewerReview.body);
    setRecommend(viewerReview.recommend);
    setNotice(null);
    setError(null);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setNotice(null);
    setError(null);
    resetForm();
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };

  const load = useMemo(
    () => async () => {
      setIsLoading(true);
      setError(null);
      try {
        const next = await apiRequest<ReviewListResult>(
          `/api/reviews?packKey=${encodeURIComponent(pack.packKey)}`,
        );
        setState(next);
        onReviewSummary?.(next.summary);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load reviews.");
      } finally {
        setIsLoading(false);
      }
    },
    [onReviewSummary, pack.packKey],
  );

  useEffect(() => {
    void load();
  }, [load, auth.user?.id]);

  useEffect(() => {
    let cancelled = false;
    setVerifiedPublisherId(null);
    apiRequest<PackOwnership>(
      `/api/ownership?packKey=${encodeURIComponent(pack.packKey)}&sourceUrl=${encodeURIComponent(
        pack.source,
      )}`,
    )
      .then((ownership) => {
        if (cancelled) return;
        setVerifiedPublisherId(
          ownership.verificationStatus === "verified" && ownership.publisher
            ? ownership.publisher.id
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setVerifiedPublisherId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pack.packKey, pack.source]);

  // Reset edit mode + draft when the pack or signed-in identity changes. App.tsx's
  // if-chain keeps ReviewPanel mounted across pack routes, so a draft for pack A
  // would otherwise bleed into pack B (and survive a sign-out/sign-in); clearing
  // state re-arms the `state !== null` gate so the composer waits for the new pack's
  // server truth instead of seeding from the previous pack's review.
  useEffect(() => {
    setIsEditing(false);
    resetForm();
    setNotice(null);
    setState(null);
  }, [pack.packKey, auth.user?.id]);

  useEffect(() => {
    if (isEditing) titleInputRef.current?.focus();
  }, [isEditing]);

  // Post-save/post-delete focus runs from an effect, not a rAF fired inside the async
  // handler: the Edit button (collapsed row) and title input (blank form) are only
  // attached to their refs after React commits the transition, so a rAF could beat the
  // commit and no-op, dropping focus to <body> when the Save/Delete button unmounts.
  useEffect(() => {
    if (!pendingFocus) return;
    if (pendingFocus === "edit") editButtonRef.current?.focus();
    else titleInputRef.current?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  const submitReview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!auth.user || !auth.csrfToken || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const input: ReviewInput = {
        packKey: pack.packKey,
        rating,
        title,
        body,
        recommend,
      };
      await apiRequest("/api/reviews", { method: "PUT", body: JSON.stringify(input) }, auth.csrfToken);
      setNotice("Review saved.");
      await load();
      setIsEditing(false);
      resetForm();
      setPendingFocus("edit");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save review.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const deleteReview = async () => {
    if (!auth.csrfToken || !viewerReview || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await apiRequest(
        `/api/reviews?packKey=${encodeURIComponent(pack.packKey)}`,
        { method: "DELETE" },
        auth.csrfToken,
      );
      setNotice("Review deleted.");
      await load();
      setIsEditing(false);
      resetForm();
      setPendingFocus("title");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete review.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleStar = async () => {
    if (!auth.csrfToken || !state) return;
    const nextStarred = !state.viewerHasStarred;
    setState({ ...state, viewerHasStarred: nextStarred });
    try {
      await apiRequest(
        "/api/stars",
        {
          method: "PUT",
          body: JSON.stringify({ packKey: pack.packKey, starred: nextStarred }),
        },
        auth.csrfToken,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update saved pack.");
      await load();
    }
  };

  const submitReport = async (review: ReviewRow) => {
    if (!auth.csrfToken) return;
    try {
      const result = await apiRequest<{ reported: boolean; alreadyReported: boolean }>(
        `/api/reviews/${encodeURIComponent(review.id)}/report`,
        { method: "POST", body: JSON.stringify({ reason: reportReason }) },
        auth.csrfToken,
      );
      setNotice(result.alreadyReported ? "You already reported that review." : "Report submitted.");
      setReportingId(null);
      setReportReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to report review.");
    }
  };

  const summary = state?.summary;

  return (
    <Card className="reviewsPanel" aria-labelledby="reviews-title">
      <CardHeader eyebrow="Community signal" title={<span id="reviews-title">Reviews</span>} />
      {/* Summary lives in the card BODY (not the CardHeader action slot, which doesn't
          wrap and overflowed the viewport at mobile widths). A wrapping flex row. */}
      <div className="reviewSummary" aria-label="Review summary">
        <span>
          <Star size={15} aria-hidden="true" />
          {summary?.averageRating ?? "No rating"}
        </span>
        <span>{summary?.count ?? 0} reviews</span>
        <span>{summary?.recommendCount ?? 0} recommend</span>
      </div>

      {auth.user ? (
        <div className="reviewComposer">
          <div className="reviewComposerHeader">
            <strong>
              {viewerReview ? (isEditing ? "Update your review" : "Your review") : "Review this pack"}
            </strong>
            <Button
              variant={state?.viewerHasStarred ? "secondary" : "ghost"}
              className={state?.viewerHasStarred ? "savePackButton active" : "savePackButton"}
              type="button"
              onClick={() => void toggleStar()}
              aria-pressed={Boolean(state?.viewerHasStarred)}
              iconStart={
                <Star size={15} fill={state?.viewerHasStarred ? "currentColor" : "none"} />
              }
            >
              {state?.viewerHasStarred ? "Saved" : "Save"}
            </Button>
          </div>
          {/* Loading gate: the composer body waits for the initial GET so a returning
              reviewer never sees a blank form flash (and lose a draft) before the
              server truth (viewerReview) is known. The header row stays rendered. */}
          {state !== null &&
            (viewerReview && !isEditing ? (
              <div className="viewerReviewSummary">
                <p>
                  You rated this pack {viewerReview.rating}/5 on{" "}
                  {new Date(viewerReview.updatedAt).toLocaleDateString()}.
                </p>
                <div className="formActions">
                  <Button
                    ref={editButtonRef}
                    variant="secondary"
                    type="button"
                    onClick={startEditing}
                    iconStart={<Pencil size={15} />}
                  >
                    Edit review
                  </Button>
                  <Button
                    variant="danger"
                    type="button"
                    onClick={() => void deleteReview()}
                    loading={isSubmitting}
                    iconStart={isSubmitting ? undefined : <Trash2 size={15} />}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={(event) => void submitReview(event)}>
                <fieldset className="ratingField">
                  <legend>Rating</legend>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={rating >= value ? "active" : ""}
                      aria-label={`${value} star${value === 1 ? "" : "s"}`}
                      onClick={() => setRating(value)}
                    >
                      <Star size={18} fill={rating >= value ? "currentColor" : "none"} />
                    </button>
                  ))}
                </fieldset>
                <Input
                  ref={titleInputRef}
                  label="Title"
                  value={title}
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Short summary"
                />
                <label className="reviewBodyField">
                  <span>Review</span>
                  <textarea
                    value={body}
                    rows={5}
                    maxLength={4000}
                    onChange={(event) => setBody(event.target.value)}
                    placeholder="What worked, what did not, and who should use it?"
                    required
                  />
                </label>
                <label className="checkboxRow">
                  <input
                    type="checkbox"
                    checked={recommend}
                    onChange={(event) => setRecommend(event.target.checked)}
                  />
                  <span>Recommend this pack</span>
                </label>
                <div className="formActions">
                  {isEditing ? (
                    <Button variant="ghost" type="button" onClick={cancelEditing}>
                      Cancel
                    </Button>
                  ) : null}
                  <Button
                    variant="primary"
                    type="submit"
                    loading={isSubmitting}
                    iconStart={isSubmitting ? undefined : <Save size={15} />}
                  >
                    {isSubmitting ? "Saving" : "Save review"}
                  </Button>
                </div>
              </form>
            ))}
        </div>
      ) : (
        <div className="signInPromptInline">
          <strong>Sign in to review and save packs.</strong>
          <p>Reviews use your Gas City account identity and can be edited later.</p>
          <div className="promptActions">
            {auth.devAuthEnabled ? (
              <Button variant="ghost" type="button" onClick={devSignIn}>
                Dev sign in
              </Button>
            ) : null}
            <Button variant="primary" type="button" onClick={signIn}>
              Sign in
            </Button>
          </div>
        </div>
      )}

      <p className="formNotice" role="status">
        {notice}
      </p>
      {error ? (
        <div className="formError" role="alert">
          <ErrorState compact message={error} />
          {/* Recovery path for a failed INITIAL load only (state === null): the composer
              body is gated on state, so without this a transient GET failure would lock a
              signed-in user out of reviewing with no retry. Save/delete errors keep state
              non-null and already have their form, so they never render this. */}
          {state === null && !isLoading ? (
            <div className="formActions">
              <Button variant="secondary" type="button" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {isLoading ? (
        <div className="inlineState">
          <Loader2 className="spin" size={18} />
          Loading reviews
        </div>
      ) : state?.reviews.length === 0 ? (
        <p className="mutedText">No reviews yet.</p>
      ) : (
        <div className="reviewList">
          {state?.reviews.map((review) => (
            <article key={review.id} className="reviewItem">
              <div className="reviewItemHeader">
                <div>
                  <strong>{review.title || `${review.rating}/5 review`}</strong>
                  <div className="reviewMeta">
                    <span>@{review.user.handle} · {new Date(review.updatedAt).toLocaleDateString()}</span>
                    {verifiedPublisherId === review.user.id ? (
                      <Badge
                        status="success"
                        dot
                        className="verifiedAuthorBadge"
                        title="Verified pack author"
                      >
                        Verified author
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <span className="reviewRating">
                  <Star size={14} fill="currentColor" /> {review.rating}
                </span>
              </div>
              <p>{review.body}</p>
              {review.recommend ? (
                <span className="recommendBadge">
                  <ThumbsUp size={14} /> Recommends
                </span>
              ) : null}
              {auth.user && auth.user.id !== review.user.id ? (
                reportingId === review.id ? (
                  <form
                    className="reportForm"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitReport(review);
                    }}
                  >
                    <textarea
                      rows={3}
                      maxLength={500}
                      value={reportReason}
                      onChange={(event) => setReportReason(event.target.value)}
                      placeholder="Why should a moderator review this?"
                      required
                    />
                    <div className="formActions">
                      <Button variant="ghost" type="button" onClick={() => setReportingId(null)}>
                        Cancel
                      </Button>
                      <Button variant="primary" type="submit">
                        Submit report
                      </Button>
                    </div>
                  </form>
                ) : (
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => setReportingId(review.id)}
                    iconStart={<Flag size={14} />}
                  >
                    Report
                  </Button>
                )
              ) : null}
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
