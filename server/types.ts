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

export type ApiTokenRow = {
  id: string;
  label: string;
  prefix: string;
  kind: "personal" | "github_actions_publish";
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type ApiTokenCreateResult = ApiTokenRow & {
  token: string;
};

export type ApiTokenAuthResult = {
  tokenId: string;
  kind: ApiTokenRow["kind"];
  constraints?: ApiTokenPublishConstraints;
  user: SessionUser;
};

export type ApiTokenPublishConstraints = {
  repoUrl: string;
  commit: string;
  packPath: string;
  requestedName: string;
  requestedVersion: string;
};

export type CliDeviceCodeCreateResult = {
  deviceCode: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
};

export type CliDevicePollResult =
  | {
      status: "pending";
      intervalSeconds: number;
    }
  | {
      status: "approved";
      token: ApiTokenCreateResult;
    }
  | {
      status: "denied" | "expired";
    };

export type IdentityClaims = {
  subject: string;
  gasCityUserId: string;
  gasCityAccountId?: string;
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

export type PublisherSummary = {
  id: string;
  handle: string;
  displayName: string;
  kind: "user" | "org";
  trusted: boolean;
  githubOwnerLogin?: string;
  githubOwnerId?: string;
};

export type SourceRepository = {
  host: "github.com";
  owner: string;
  name: string;
  fullName: string;
};

export type PackOwnership = {
  packKey: string;
  sourceUrl: string;
  githubRepositoryId?: string;
  sourceRepository?: SourceRepository;
  verificationStatus: "unverified" | "verified";
  verificationMethod?: "github_app_user_token" | "manual";
  publisher?: PublisherSummary;
  verifiedAt?: string;
};

export type VerifiedPackOwnershipInput = {
  packKey: string;
  sourceUrl: string;
  githubRepositoryId: string;
  githubRepositoryFullName: string;
  githubRepositoryName: string;
  githubOwnerId: string;
  githubOwnerLogin: string;
  githubOwnerType: "User" | "Organization";
  verificationMethod: "github_app_user_token" | "manual";
};

export type PublishRequestStatus =
  | "pending_validation"
  | "validation_failed"
  | "pending_review"
  | "approved"
  | "rejected";

export type GitHubRepositoryRef = {
  host: "github.com";
  owner: string;
  name: string;
  fullName: string;
};

export type PublishRequestInput = {
  repoUrl: string;
  commit: string;
  packPath?: string;
  requestedName: string;
  requestedVersion: string;
  requestedRef?: string;
  requestedDescription?: string;
};

export type GitHubPublishCandidate = {
  id: string;
  repository: {
    id: string;
    fullName: string;
    owner: string;
    name: string;
    htmlUrl: string;
    defaultBranch: string;
    permission: "admin" | "maintain" | "push";
  };
  branch: string;
  commit: string;
  packPath: string;
  packTomlPath: string;
  pack: {
    name: string;
    version?: string;
    description?: string;
  };
  warnings: string[];
};

export type GitHubPublishImportCreateInput = {
  repositoriesScanned: number;
  privateRepositoriesSkipped: number;
  candidates: GitHubPublishCandidate[];
  scanErrors: string[];
  truncated: boolean;
  expiresAt: Date;
};

export type GitHubPublishImportRow = Omit<GitHubPublishImportCreateInput, "expiresAt"> & {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
};

export type PublishRegistryRelease = {
  version: string;
  ref: string;
  commit: string;
  hash: string;
  description: string;
};

export type PublishRegistryEntry = {
  name: string;
  description: string;
  source: string;
  sourceKind: "git";
  release: PublishRegistryRelease;
};

export type NormalizedPublishRequestInput = PublishRequestInput & {
  repository: GitHubRepositoryRef;
  repoUrl: string;
  sourceUrl: string;
  packPath: string;
};

export type PublishRequestRow = {
  id: string;
  status: PublishRequestStatus;
  repository: GitHubRepositoryRef;
  repoUrl: string;
  sourceUrl: string;
  packPath: string;
  commit: string;
  requestedName: string;
  requestedVersion: string;
  requestedRef?: string;
  requestedDescription?: string;
  registryEntry?: PublishRegistryEntry;
  validationError?: string;
  validatedAt?: string;
  statusReason?: string;
  reviewedAt?: string;
  reviewedBy?: PublicUser;
  createdAt: string;
  updatedAt: string;
  submittedBy: PublicUser;
};

export interface RegistryStore {
  readonly kind: "file" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;
  ensureUser(identity: IdentityClaims): Promise<SessionUser>;
  getSession(token: string): Promise<SessionRecord | null>;
  createSession(userId: string): Promise<{ token: string; csrfToken: string; expiresAt: Date }>;
  destroySession(token: string): Promise<void>;
  getUserForApiToken(token: string): Promise<ApiTokenAuthResult | null>;
  listApiTokens(userId: string): Promise<ApiTokenRow[]>;
  createApiToken(userId: string, input: {
    label?: string;
    kind?: ApiTokenRow["kind"];
    expiresAt?: Date;
    constraints?: ApiTokenPublishConstraints;
  }): Promise<ApiTokenCreateResult>;
  revokeApiToken(userId: string, tokenId: string): Promise<void>;
  createCliDeviceCode(input: {
    deviceCode: string;
    userCode: string;
    label?: string;
    expiresAt: Date;
    intervalSeconds: number;
  }): Promise<CliDeviceCodeCreateResult>;
  pollCliDeviceCode(deviceCode: string): Promise<CliDevicePollResult>;
  approveCliDeviceCode(userId: string, userCode: string): Promise<void>;
  denyCliDeviceCode(userId: string, userCode: string): Promise<void>;
  updateUserProfile(
    userId: string,
    input: { displayName: string; handle?: string },
  ): Promise<SessionUser>;
  setUserRoleForDev(userId: string, role: "admin" | "moderator" | "user"): Promise<SessionUser>;
  listReviews(packKey: string, viewerUserId?: string): Promise<ReviewListResult>;
  upsertReview(userId: string, input: ReviewInput): Promise<ReviewRow>;
  deleteReview(userId: string, packKey: string): Promise<void>;
  reportReview(userId: string, reviewId: string, reason: string): Promise<{
    reported: boolean;
    alreadyReported: boolean;
  }>;
  listAccountReviews(userId: string): Promise<AccountReview[]>;
  setStar(userId: string, packKey: string, starred: boolean): Promise<{ starred: boolean }>;
  getPackOwnership(packKey: string, sourceUrl: string): Promise<PackOwnership | null>;
  upsertVerifiedPackOwnership(
    userId: string,
    input: VerifiedPackOwnershipInput,
  ): Promise<PackOwnership>;
  deletePackOwnershipsForGithubRepositoryIds(
    repositoryIds: string[],
    reason: string,
  ): Promise<number>;
  createGitHubPublishImport(
    userId: string,
    input: GitHubPublishImportCreateInput,
  ): Promise<GitHubPublishImportRow>;
  getGitHubPublishImport(userId: string, id: string): Promise<GitHubPublishImportRow | null>;
  createPublishRequest(userId: string, input: PublishRequestInput): Promise<PublishRequestRow>;
  getPublishRequest(id: string): Promise<PublishRequestRow | null>;
  listAccountPublishRequests(userId: string): Promise<PublishRequestRow[]>;
  listPublishRequests(): Promise<PublishRequestRow[]>;
  listApprovedPublishRequests(): Promise<PublishRequestRow[]>;
  markPublishRequestValidated(
    id: string,
    entry: PublishRegistryEntry,
  ): Promise<PublishRequestRow>;
  markPublishRequestValidationFailed(id: string, error: string): Promise<PublishRequestRow>;
  approvePublishRequest(actorUserId: string, id: string): Promise<PublishRequestRow>;
  rejectPublishRequest(
    actorUserId: string,
    id: string,
    reason: string,
  ): Promise<PublishRequestRow>;
}
