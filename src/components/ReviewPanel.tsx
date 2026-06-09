import { Flag, Loader2, Save, Star, ThumbsUp, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  type AuthState,
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

  const viewerReview = state?.viewerReview ?? null;
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [recommend, setRecommend] = useState(true);

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
    if (!viewerReview) {
      setRating(5);
      setTitle("");
      setBody("");
      setRecommend(true);
      return;
    }
    setRating(viewerReview.rating);
    setTitle(viewerReview.title ?? "");
    setBody(viewerReview.body);
    setRecommend(viewerReview.recommend);
  }, [viewerReview?.id, viewerReview?.updatedAt]);

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
    <section className="reviewsPanel" aria-labelledby="reviews-title">
      <div className="reviewsHeader">
        <div>
          <p className="eyebrow">Community signal</p>
          <h2 id="reviews-title">Reviews</h2>
        </div>
        <div className="reviewSummary" aria-label="Review summary">
          <span>
            <Star size={15} aria-hidden="true" />
            {summary?.averageRating ?? "No rating"}
          </span>
          <span>{summary?.count ?? 0} reviews</span>
          <span>{summary?.recommendCount ?? 0} recommend</span>
        </div>
      </div>

      {auth.user ? (
        <div className="reviewComposer">
          <div className="reviewComposerHeader">
            <strong>{viewerReview ? "Update your review" : "Review this pack"}</strong>
            <button
              className={state?.viewerHasStarred ? "savePackButton active" : "savePackButton"}
              type="button"
              onClick={() => void toggleStar()}
              aria-pressed={Boolean(state?.viewerHasStarred)}
            >
              <Star size={15} fill={state?.viewerHasStarred ? "currentColor" : "none"} />
              {state?.viewerHasStarred ? "Saved" : "Save"}
            </button>
          </div>
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
            <label>
              <span>Title</span>
              <input
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Short summary"
              />
            </label>
            <label>
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
              {viewerReview ? (
                <button className="textDangerButton" type="button" onClick={() => void deleteReview()}>
                  <Trash2 size={15} />
                  Delete
                </button>
              ) : null}
              <button className="iconTextButton primary" type="submit" disabled={isSubmitting}>
                <Save size={15} />
                {isSubmitting ? "Saving" : "Save review"}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="signInPromptInline">
          <strong>Sign in to review and save packs.</strong>
          <p>Reviews use your Gas City account identity and can be edited later.</p>
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
        </div>
      )}

      {notice ? <p className="formNotice">{notice}</p> : null}
      {error ? <p className="formError" role="alert">{error}</p> : null}
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
                  <span>
                    @{review.user.handle} · {new Date(review.updatedAt).toLocaleDateString()}
                  </span>
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
                      <button type="button" className="iconTextButton" onClick={() => setReportingId(null)}>
                        Cancel
                      </button>
                      <button type="submit" className="iconTextButton primary">
                        Submit report
                      </button>
                    </div>
                  </form>
                ) : (
                  <button className="smallMutedButton" type="button" onClick={() => setReportingId(review.id)}>
                    <Flag size={14} /> Report
                  </button>
                )
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
