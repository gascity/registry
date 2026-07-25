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
  kind: ApiTokenRow["kind"] | "sts_eia";
  constraints?: ApiTokenPublishConstraints;
  user: SessionUser;
};

export type ApiTokenPublishConstraints = {
  repoUrl: string;
  commit: string;
  packPath: string;
  requestedName: string;
  requestedVersion: string;
  // GitHub's numeric ids for the repo + owner the minting OIDC token proved. Carried on the
  // token so the submit path can stamp them server-side without trusting the request body;
  // NOT part of the scope comparison (that stays on the request fields the client sends).
  githubRepositoryId?: string;
  githubOwnerId?: string;
  // The git ref and workflow event the minting OIDC token was issued for. FORENSICS ONLY: recorded
  // in the unattended-approval audit row, never compared and never an admission input. Gating on
  // "publishes only from a tag / protected branch" is the repo owner's control (branch protection,
  // environment reviewers), not something the registry can guess for every publisher.
  ref?: string;
  eventName?: string;
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
  // True when the auth adapter accepts the `registry-staff` role for this login. Gas City OIDC
  // requires both the signed current-broker claim and the persistent realm role. Drives a
  // promote-only elevation to admin in ensureUser.
  assertedAdmin?: boolean;
  // True when the auth adapter accepts the `registry-member` role for this login. Live-synced
  // onto users.org_member in ensureUser on EVERY login (absent => false => de-provision), unlike
  // assertedAdmin's promote-only elevation.
  assertedOrgMember?: boolean;
};

// The reason the publish merge gate was satisfied, threaded from the gate into the approve
// audit record. org_member is stamped here because users.org_member is live-synced and the
// stored value at investigation time can differ from the value at approval time.
export type PublishApprovalDecision = {
  ownershipOverrideReason?: string;
  ownershipBasis?: "repo_proven" | "verified_repo_ownership" | "org_member" | "override";
  // Staff authorization to RE-POINT the name's existing claim at this request's repo — the
  // audited repo-migration path. Set by the merge gate only after it has both found a claim
  // mismatch AND been handed this justification; the store performs the re-point inside the
  // approve transaction. Deliberately NOT the same field as ownershipOverrideReason: an
  // override waved through for an ownership reason must not silently move a name too.
  namePinOverrideReason?: string;
  // What the approval did to the pack's name claim: minted the first claim, matched the claim
  // already on file, or re-pointed it under a staff override. Derived by the store at approve
  // time (never supplied by the caller) and recorded in the approve audit row.
  namePin?: "created" | "matched" | "repinned";
  // Present only on the unattended path. Carries what the audit row needs to reconstruct WHY no
  // human was required: the served release the automation matched against, plus the OIDC ref/event
  // the release was cut from. Never set by the staff approve route, and ignored by it — the store
  // decides staff-vs-auto from WHICH entry point was called, not from this field.
  autoApprove?: PublishAutoApproveContext;
};

// The forensic context of one unattended approval. Assembled per HTTP request from the auth context
// that carried the OIDC-minted publish token; never persisted anywhere but the audit row.
export type PublishAutoApproveContext = {
  // The currently-served approved request the repeat release was measured against.
  precedentRequestId: string;
  ref?: string;
  eventName?: string;
};

// An unattended approval must carry its context, so the audit row can never claim `approvalMode:
// "auto"` without recording what it matched against.
export type AutoPublishApprovalDecision = PublishApprovalDecision & {
  autoApprove: PublishAutoApproveContext;
};

// Options for a staff takedown. Releasing the name claim is opt-in and separate from the
// takedown itself: most withdrawals are content takedowns where the name must stay pinned to
// the repo that owns it, and only a deliberate "free this name" decision unclaims it.
export type PublishWithdrawOptions = {
  releaseNameClaim?: boolean;
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
  // The user who proved control of the source repo for this row. The merge gate's
  // ownership escape hatch binds to this (per-repo, per-user), NOT org-wide publisher
  // membership, so proving one repo never authorizes publishing a sibling repo.
  verifiedByUserId?: string;
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

// Durable binding of a pack name to the repo/owner that first published it, written when a
// publish request for a previously unclaimed name is approved. Names are global and permanent
// once served, so the first approval is what every later release of that name is measured
// against. Distinct from PackOwnership, which is keyed per catalog pack_key and records who
// PROVED control of the source repo (the Trust-tab badge); this row records which repo a NAME
// belongs to, and it is the only one of the two the merge gate consults.
export type PackNameClaim = {
  name: string;
  // The `acme` of `acme/tools`; absent for a legacy bare name.
  scope?: string;
  repoFullName: string;
  // GitHub's numeric ids — stable across repo and account renames, which the logins are not.
  // Absent when the claiming publish path never proved them (claim-only submissions).
  githubRepositoryId?: string;
  githubOwnerId?: string;
  githubOwnerLogin: string;
  claimedByUserId?: string;
  // The approved publish request the claim was derived from.
  sourceRequestId?: string;
  createdAt: string;
  updatedAt: string;
};

export type PublishRequestStatus =
  | "pending_validation"
  | "validation_failed"
  | "pending_review"
  | "approved"
  | "rejected"
  | "withdrawn";

// How a publish request was authenticated, derived server-side at submission time
// (never read from the request body). `github_actions_oidc` and `github_import` are
// repo-proven — the submitter demonstrated control of the source repo (a verified
// GitHub Actions OIDC token, or a GitHub App push/admin candidate). `web_session` and
// `api_token` are claim-only: the submitter merely asserts a repo URL + pack name.
export type PublishSubmissionMethod =
  | "web_session"
  | "api_token"
  | "github_actions_oidc"
  | "github_import";

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
    // GitHub's numeric owner id, when the discovery response carried it. Optional so
    // candidates from imports created before it was captured still normalize.
    ownerId?: string;
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
  submissionMethod?: PublishSubmissionMethod;
  // See PublishSourceIdentity: stamped server-side at submission, absent on claim-only paths
  // and on every row that predates the columns.
  sourceGithubRepositoryId?: string;
  sourceGithubOwnerId?: string;
};

// GitHub's numeric ids for a publish request's source, derived server-side from the trusted
// auth context at submission time (the OIDC-minted token's constraints, or an App-discovered
// import candidate) — never read from the request body, same doctrine as submissionMethod.
// Absent for claim-only paths, which prove nothing about the repo.
export type PublishSourceIdentity = {
  githubRepositoryId?: string;
  githubOwnerId?: string;
};

export interface RegistryStore {
  readonly kind: "file" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;
  // Cheap readiness probe: resolves iff the backing store can currently serve queries.
  ping(): Promise<void>;
  ensureUser(identity: IdentityClaims): Promise<SessionUser>;
  getOrCreateUserForEiaSubject(subject: string): Promise<SessionUser | null>;
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
  // The ownership row for a catalog pack_key, or null while the pack is unverified. Keyed by
  // pack_key ALONE: source_url is a stored descriptive column that legitimately moves (a direct
  // pack's catalog `source` is frozen at its earliest approved release, so withdrawing that
  // release re-creates the pack at a different commit), and putting a mutable string in the
  // read predicate could only ever hide a live row. Callers that care which repository the row
  // belongs to compare `sourceRepository` themselves.
  getPackOwnership(packKey: string): Promise<PackOwnership | null>;
  // The GitHub numeric repository id `userId` personally proved control of for `repoFullName` —
  // i.e. a verified pack-ownership row exists for that repo whose verified_by_user_id is this
  // user — or null when they proved nothing. Binds per-repo + per-user (NOT org-wide publisher
  // membership), and matches on repo identity rather than the commit-bearing publish sourceUrl, so
  // it authorizes new releases from a repo the submitter themselves onboarded.
  //
  // Returns the ID rather than a boolean because the merge gate needs both halves of the proof:
  // that SOMETHING was proven, and WHICH repo it was. github_repository_full_name is mutable (a
  // rename or a delete-and-recreate moves it), so a row that matches the name is not on its own
  // proof that the caller controls the repo a name claim is PINNED to.
  verifiedRepoOwnershipRepositoryId(userId: string, repoFullName: string): Promise<string | null>;
  // True when the user's last login carried a trusted registry-member assertion
  // (users.org_member, live-synced by ensureUser). Read by the publish merge gate.
  isOrgMember(userId: string): Promise<boolean>;
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
  createPublishRequest(
    userId: string,
    input: PublishRequestInput,
    submissionMethod: PublishSubmissionMethod,
    sourceIdentity?: PublishSourceIdentity,
  ): Promise<PublishRequestRow>;
  getPublishRequest(id: string): Promise<PublishRequestRow | null>;
  listAccountPublishRequests(userId: string): Promise<PublishRequestRow[]>;
  listPublishRequests(): Promise<PublishRequestRow[]>;
  listApprovedPublishRequests(): Promise<PublishRequestRow[]>;
  // Withdrawn rows for one name@version — feeds the anti-content-swap reinstatement guard. Scoped
  // (not a full list) so it stays O(index-hit) and can never truncate past the conflicting row.
  listWithdrawnPublishRequestsForVersion(name: string, version: string): Promise<PublishRequestRow[]>;
  // Every staff REFUSAL of a name, across every version and spanning both refusal verbs: a
  // `withdrawn` row (takedown of a served release) and a `rejected` row that names a reviewer (the
  // only "no" a queued release can receive). Deliberately broader than the name@version lookup
  // above: unattended approval refuses any name staff have ever said no to, because a takedown of
  // 1.0.0 for malware must also stop an unread 1.0.1 carrying the same payload, and a reject staff
  // have to re-do on every CI run is durable for nothing. Scoping this to one version would collapse
  // it into the reinstatement guard. Rejected rows with a NULL reviewer are SUPERSEDED corrections,
  // not refusals, and are excluded.
  listStaffRefusedPublishRequestsForName(name: string): Promise<PublishRequestRow[]>;
  // The most recently submitted release of `name` that is currently SERVED (status `approved`), or
  // null when none is. NOT implied by a name claim: a withdraw drops the claim only when staff
  // explicitly release it, so a pack whose entire history was taken down keeps its claim and loses
  // its precedent. That is the per-pack kill switch for unattended approval — withdraw every
  // release and the next one goes back to a human.
  getServedPublishPrecedent(name: string): Promise<PublishRequestRow | null>;
  // The name→owner binding for a pack name, or null while the name is unclaimed. Written by
  // approvePublishRequest (first approval of a name wins; a later approval re-points it only under
  // a staff namePinOverrideReason) and by the init() backfill; dropped by a withdraw that asked to
  // release it. Read by the publish merge gate, which measures every incoming release against it.
  getPackNameClaim(name: string): Promise<PackNameClaim | null>;
  // The same bindings for MANY names in one round trip, ordered by name, deduplicated, omitting
  // names that are unclaimed. Read by the catalog render path (server/aggregate.ts), which needs
  // every approved bare name's claim on a single request and must not degrade into one query per
  // approved pack. Never null-padded: absent means unclaimed.
  listPackNameClaims(names: string[]): Promise<PackNameClaim[]>;
  markPublishRequestValidated(
    id: string,
    entry: PublishRegistryEntry,
  ): Promise<PublishRequestRow>;
  markPublishRequestValidationFailed(id: string, error: string): Promise<PublishRequestRow>;
  approvePublishRequest(
    actorUserId: string,
    id: string,
    options?: PublishApprovalDecision,
  ): Promise<PublishRequestRow>;
  // Unattended approval: same transaction, same advisory lock, same claim critical section as the
  // staff route (both delegate to one private body), differing only in what it records — NULL
  // reviewer, the auto status_reason, and an audit row marked `approvalMode: "auto"`. There is no
  // actor id to pass because there is no actor: the audit row's actor_user_id is NULL, the same
  // shape auditSystem already writes.
  autoApprovePublishRequest(
    id: string,
    options: AutoPublishApprovalDecision,
  ): Promise<PublishRequestRow>;
  rejectPublishRequest(
    actorUserId: string,
    id: string,
    reason: string,
  ): Promise<PublishRequestRow>;
  // Takedown of an already-approved (currently-served) publish. Terminal: approved -> withdrawn.
  // With options.releaseNameClaim the pack name's claim is dropped in the SAME step, so the
  // takedown and the unclaim can never half-apply.
  withdrawPublishRequest(
    actorUserId: string,
    id: string,
    reason: string,
    options?: PublishWithdrawOptions,
  ): Promise<PublishRequestRow>;
}
