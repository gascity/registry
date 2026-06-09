import { Save, Star, UserRound } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { apiRequest, type AuthState, type ReviewRow } from "../lib/api";

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
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(auth.user?.displayName ?? "");
    setHandle(auth.user?.handle ?? "");
  }, [auth.user]);

  useEffect(() => {
    if (!auth.user || !auth.csrfToken) return;
    void apiRequest<{ reviews: ReviewRow[] }>("/api/account/reviews", {}, auth.csrfToken)
      .then((result) => setReviews(result.reviews))
      .catch(() => setReviews([]));
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
      </div>
    </main>
  );
}
