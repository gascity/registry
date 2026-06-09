export type PublicUser = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  email?: string;
  role: "admin" | "moderator" | "user";
};

export type SessionUser = PublicUser & {
  status: "active" | "disabled";
};

export type SessionRecord = {
  id: string;
  user: SessionUser;
  csrfToken: string;
  expiresAt: Date;
};

export type IdentityClaims = {
  subject: string;
  email?: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
};

export type ReviewInput = {
  packKey: string;
  rating: number;
  title?: string;
  body: string;
  recommend: boolean;
};

export type ReviewRow = {
  id: string;
  packKey: string;
  rating: number;
  title?: string;
  body: string;
  recommend: boolean;
  createdAt: string;
  updatedAt: string;
  user: PublicUser;
  viewerCanDelete: boolean;
};

export type ReviewSummary = {
  count: number;
  averageRating: number | null;
  recommendCount: number;
};

export type ReviewListResult = {
  summary: ReviewSummary;
  reviews: ReviewRow[];
  viewerReview: ReviewRow | null;
  viewerHasStarred: boolean;
};

export type AccountReview = ReviewRow & {
  packKey: string;
};

export interface RegistryStore {
  readonly kind: "file" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;
  ensureUser(identity: IdentityClaims): Promise<SessionUser>;
  getSession(token: string): Promise<SessionRecord | null>;
  createSession(userId: string): Promise<{ token: string; csrfToken: string; expiresAt: Date }>;
  destroySession(token: string): Promise<void>;
  updateUserProfile(
    userId: string,
    input: { displayName: string; handle?: string },
  ): Promise<SessionUser>;
  listReviews(packKey: string, viewerUserId?: string): Promise<ReviewListResult>;
  upsertReview(userId: string, input: ReviewInput): Promise<ReviewRow>;
  deleteReview(userId: string, packKey: string): Promise<void>;
  reportReview(userId: string, reviewId: string, reason: string): Promise<{
    reported: boolean;
    alreadyReported: boolean;
  }>;
  listAccountReviews(userId: string): Promise<AccountReview[]>;
  setStar(userId: string, packKey: string, starred: boolean): Promise<{ starred: boolean }>;
}
