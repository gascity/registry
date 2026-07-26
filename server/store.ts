import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import postgres, { type ISql, type Sql } from "postgres";
import { hashCliDeviceCode, hashCliUserCode, normalizeCliUserCode } from "./cli-auth";
import { randomToken, sha256 } from "./crypto";
import {
  AUTO_APPROVED_STATUS_REASON,
  nameClaimMatchesRequest,
  normalizePublishRequestInput,
  packNameScope,
} from "./publish";
import { generateApiToken, hashApiToken } from "./tokens";
import type {
  AccountReview,
  ApiTokenAuthResult,
  AutoPublishApprovalDecision,
  ApiTokenCreateResult,
  ApiTokenPublishConstraints,
  ApiTokenRow,
  CatalogPublisherAttribution,
  CliDeviceCodeCreateResult,
  CliDevicePollResult,
  GitHubPublishCandidate,
  GitHubPublishImportCreateInput,
  GitHubPublishImportRow,
  IdentityClaims,
  PackNameClaim,
  PackOwnership,
  PublisherSummary,
  PublishRegistryEntry,
  PublishRequestInput,
  PublishRequestRow,
  PublishSourceIdentity,
  PublishSubmissionMethod,
  PublishWithdrawOptions,
  PublicUser,
  RegistryStore,
  ReviewInput,
  ReviewListResult,
  ReviewRow,
  PublishApprovalDecision,
  PublishAutoApproveContext,
  SessionRecord,
  SessionUser,
  VerifiedPackOwnershipInput,
} from "./types";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const API_TOKEN_TOUCH_MIN_INTERVAL_MS = 15 * 60 * 1000;
const idPrefix = {
  user: "usr",
  session: "ses",
  apiToken: "apt",
  cliDeviceCode: "cdc",
  review: "rev",
  report: "rpt",
  audit: "aud",
  publisher: "pub",
  publishRequest: "prq",
  githubPublishImport: "gpi",
} as const;

export function createStore(databaseUrl: string | undefined, localDataPath?: string): RegistryStore {
  if (!databaseUrl) return new FileRegistryStore(localDataPath ?? ".registry-data/registry.local.json");
  return new PostgresRegistryStore(databaseUrl);
}

function newId(prefix: keyof typeof idPrefix) {
  return `${idPrefix[prefix]}_${randomToken(18)}`;
}

function toIso(value: Date | string | number) {
  return new Date(value).toISOString();
}

function normalizeHandle(value: string | undefined) {
  const handle = value?.trim().replace(/^@/, "").toLowerCase();
  if (!handle) return undefined;
  return handle.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function normalizePublisherHandle(value: string | undefined) {
  return normalizeHandle(value) ?? "publisher";
}

function publisherTrustMutation(
  githubOwnerId: string,
  trusted: boolean,
  audit: { operator: string; reason: string },
) {
  const ownerId = githubOwnerId.trim();
  const operator = audit.operator.trim();
  const reason = audit.reason.trim();
  if (!ownerId) throw new StoreValidationError("GitHub owner id is required.");
  if (typeof trusted !== "boolean") {
    throw new StoreValidationError("Publisher trust must be a boolean.");
  }
  if (!operator) throw new StoreValidationError("Trust change operator is required.");
  if (!reason) throw new StoreValidationError("Trust change reason is required.");
  if (operator.length > 120) throw new StoreValidationError("Trust change operator is too long.");
  if (reason.length > 500) throw new StoreValidationError("Trust change reason is too long.");
  return { ownerId, trusted, operator, reason };
}

function publicUser(row: {
  id: string;
  handle: string;
  display_name: string;
  avatar_url?: string | null;
  email?: string | null;
  role: string;
}): PublicUser {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url ?? undefined,
    email: row.email ?? undefined,
    role: row.role === "admin" || row.role === "moderator" ? row.role : "user",
  };
}

function publicPublisher(row: {
  id: string;
  handle: string;
  display_name: string;
  kind: string;
  trusted?: boolean | null;
  github_owner_login?: string | null;
  github_owner_id?: string | null;
}): PublisherSummary {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    kind: row.kind === "org" ? "org" : "user",
    trusted: Boolean(row.trusted),
    githubOwnerLogin: row.github_owner_login ?? undefined,
    githubOwnerId: row.github_owner_id ?? undefined,
  };
}

function sessionUser(row: {
  id: string;
  handle: string;
  display_name: string;
  avatar_url?: string | null;
  email?: string | null;
  role: string;
  status: string;
}): SessionUser {
  return {
    ...publicUser(row),
    status: row.status === "disabled" ? "disabled" : "active",
  };
}

function identityConvergenceConflict() {
  console.error("[registry] identity convergence conflict");
  return new StoreConflictError("Registry identity requires operator reconciliation.");
}

function apiTokenFromRow(row: {
  id: string;
  label: string;
  prefix: string;
  kind?: string | null;
  created_at: Date | string | number;
  expires_at?: Date | string | number | null;
  last_used_at?: Date | string | number | null;
  revoked_at?: Date | string | number | null;
}): ApiTokenRow {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    kind: row.kind === "github_actions_publish" ? "github_actions_publish" : "personal",
    createdAt: toIso(row.created_at),
    expiresAt: row.expires_at ? toIso(row.expires_at) : undefined,
    lastUsedAt: row.last_used_at ? toIso(row.last_used_at) : undefined,
    revokedAt: row.revoked_at ? toIso(row.revoked_at) : undefined,
  };
}

function normalizeApiTokenKind(value: ApiTokenRow["kind"] | undefined): ApiTokenRow["kind"] {
  return value === "github_actions_publish" ? "github_actions_publish" : "personal";
}

function normalizeApiTokenConstraints(value: unknown): ApiTokenPublishConstraints | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<ApiTokenPublishConstraints>;
  if (
    typeof raw.repoUrl !== "string" ||
    typeof raw.commit !== "string" ||
    typeof raw.packPath !== "string" ||
    typeof raw.requestedName !== "string" ||
    typeof raw.requestedVersion !== "string"
  ) {
    return undefined;
  }
  return {
    repoUrl: raw.repoUrl,
    commit: raw.commit,
    packPath: raw.packPath,
    requestedName: raw.requestedName,
    requestedVersion: raw.requestedVersion,
    githubRepositoryId: typeof raw.githubRepositoryId === "string" ? raw.githubRepositoryId : undefined,
    githubOwnerId: typeof raw.githubOwnerId === "string" ? raw.githubOwnerId : undefined,
    // This projection is a WHITELIST: a field missing from it is silently dropped on read-back, so
    // the unattended-approval audit row would have recorded an absent ref for every release while
    // every store-level test still passed. Carried, never compared.
    ref: typeof raw.ref === "string" ? raw.ref : undefined,
    eventName: typeof raw.eventName === "string" ? raw.eventName : undefined,
  };
}

function normalizeApiTokenLabel(value: string | undefined) {
  const label = value?.trim().replace(/\s+/g, " ").slice(0, 120);
  return label || "CLI token";
}

function cliDeviceCodeFromInput(input: {
  deviceCode: string;
  userCode: string;
  label?: string;
  expiresAt: Date;
  intervalSeconds: number;
}): StoredCliDeviceCode & { userCode: string } {
  const userCode = normalizeCliUserCode(input.userCode);
  return {
    id: newId("cliDeviceCode"),
    deviceCodeHash: hashCliDeviceCode(input.deviceCode),
    userCodeHash: hashCliUserCode(userCode),
    label: normalizeApiTokenLabel(input.label),
    status: "pending",
    intervalSeconds: Math.max(1, Math.min(30, Math.trunc(input.intervalSeconds))),
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    userCode,
  };
}

function cliDeviceCodeCreateResult(
  record: StoredCliDeviceCode & { userCode: string },
  deviceCode: string,
): CliDeviceCodeCreateResult {
  return {
    deviceCode,
    userCode: record.userCode,
    expiresAt: record.expiresAt,
    intervalSeconds: record.intervalSeconds,
  };
}

function isExpiredIso(value: string) {
  return Date.parse(value) <= Date.now();
}

function validateReviewInput(input: ReviewInput) {
  const packKey = input.packKey.trim();
  if (!packKey || packKey.length > 180) throw new StoreValidationError("Invalid pack key.");
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new StoreValidationError("Rating must be between 1 and 5.");
  }
  const body = input.body.trim();
  if (!body) throw new StoreValidationError("Review body required.");
  if (body.length > 4_000) throw new StoreValidationError("Review body is too long.");
  const title = input.title?.trim();
  if (title && title.length > 120) throw new StoreValidationError("Review title is too long.");
  return {
    packKey,
    rating: input.rating,
    title: title || undefined,
    body,
    recommend: Boolean(input.recommend),
  };
}

function reviewFromRows(review: any, user: PublicUser, viewerUserId?: string): ReviewRow {
  return {
    id: review.id,
    packKey: review.pack_key,
    rating: review.rating,
    title: review.title ?? undefined,
    body: review.body,
    recommend: review.recommend,
    createdAt: toIso(review.created_at),
    updatedAt: toIso(review.updated_at),
    user,
    viewerCanDelete:
      Boolean(viewerUserId && viewerUserId === user.id) ||
      user.role === "admin" ||
      user.role === "moderator",
  };
}

function ownershipFromRows(row: any): PackOwnership {
  return {
    packKey: row.pack_key,
    sourceUrl: row.source_url,
    githubRepositoryId: row.github_repository_id,
    sourceRepository: {
      host: "github.com",
      owner: row.github_owner_login,
      name: row.github_repository_name,
      fullName: row.github_repository_full_name,
    },
    verificationStatus: "verified",
    verificationMethod: row.verification_method,
    verifiedAt: row.verified_at ? toIso(row.verified_at) : undefined,
    verifiedByUserId: row.verified_by_user_id ?? undefined,
    publisher: row.publisher_id
      ? publicPublisher({
          id: row.publisher_id,
          handle: row.publisher_handle,
          display_name: row.publisher_display_name,
          kind: row.publisher_kind,
          trusted: row.publisher_trusted,
          github_owner_login: row.publisher_github_owner_login,
          github_owner_id: row.publisher_github_owner_id,
        })
      : undefined,
  };
}

function publishRequestFromRows(row: any, user: PublicUser): PublishRequestRow {
  const reviewer = row.reviewed_by_user_id && row.reviewed_by_handle
    ? publicUser({
        id: row.reviewed_by_user_id,
        handle: row.reviewed_by_handle,
        display_name: row.reviewed_by_display_name,
        avatar_url: row.reviewed_by_avatar_url,
        email: row.reviewed_by_email,
        role: row.reviewed_by_role,
      })
    : undefined;
  return {
    id: row.id,
    status: publishRequestStatus(row.status),
    repository: {
      host: "github.com",
      owner: row.repo_owner,
      name: row.repo_name,
      fullName: row.repo_full_name,
    },
    repoUrl: row.repo_url,
    sourceUrl: row.source_url,
    packPath: row.pack_path,
    commit: row.commit_sha,
    requestedName: row.requested_name,
    requestedVersion: row.requested_version,
    requestedRef: row.requested_ref ?? undefined,
    requestedDescription: row.requested_description ?? undefined,
    registryEntry: normalizeRegistryEntry(row.registry_entry),
    validationError: row.validation_error ?? undefined,
    validatedAt: row.validated_at ? toIso(row.validated_at) : undefined,
    statusReason: row.status_reason ?? undefined,
    reviewedAt: row.reviewed_at ? toIso(row.reviewed_at) : undefined,
    reviewedBy: reviewer,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    submittedBy: user,
    submissionMethod: publishSubmissionMethod(row.submission_method),
    sourceGithubRepositoryId: row.source_github_repository_id ?? undefined,
    sourceGithubOwnerId: row.source_github_owner_id ?? undefined,
  };
}

// The durable binding a name claim records, derived from the approved publish request that
// earns it. Comes from the request's own columns, so it holds for direct publishes too (which
// have no pack_ownerships row and structurally cannot). Each store stamps its own timestamps.
function nameClaimBindingFromPublishRequest(
  request: PublishRequestRow,
): Omit<PackNameClaim, "createdAt" | "updatedAt"> {
  return {
    name: request.requestedName,
    scope: packNameScope(request.requestedName),
    repoFullName: request.repository.fullName,
    githubRepositoryId: request.sourceGithubRepositoryId,
    githubOwnerId: request.sourceGithubOwnerId,
    githubOwnerLogin: request.repository.owner,
    claimedByUserId: request.submittedBy.id,
    sourceRequestId: request.id,
  };
}

// Releasing a BARE name's claim can only ever cause harm, so it is refused outright. Bare names
// are reserved: the publish gate admits one only when a claim already exists, and nothing can mint
// a bare claim afterwards (the backfill needs an approved request, approve is gate-blocked, and a
// re-pin needs a claim to move). So releasing one does not return the name to a usable pool — it
// makes the name permanently unpublishable, recoverable only by hand-editing the database.
function assertNameClaimReleasable(name: string) {
  if (!packNameScope(name)) {
    throw new StoreValidationError(
      "Unscoped pack names stay reserved; releasing the claim would make the name permanently unpublishable.",
    );
  }
}

// The previously-NULL ids an approval taught a name claim.
type NameClaimEnrichment = { githubRepositoryId?: string; githubOwnerId?: string };

// Which of a claim's NULL id columns this approval may fill, or undefined for none.
//
// THE TRUST MODEL, and this is the dangerous part of the feature. Who may teach a claim its ids:
// ONLY a publish request that has ALREADY satisfied that claim under the unchanged
// nameClaimMatchesRequest rule, and ONLY from ids the trusted auth context stamped.
//
//  1. Only on a MATCH. Enforced structurally by where the two call sites put it — inside the
//     `matched` branch, after the mismatch branch has thrown. Enriching on a mismatch IS the
//     takeover: whoever turned up would teach the claim their own ids and the claim would then
//     point at them, a direct bypass of the H2 pin.
//  2. Only into NULL columns (`incoming.github*Id` falsy). Overwriting a KNOWN id is a re-pin, and
//     a re-pin requires an explicit staff namePinOverrideReason plus its own from/to audit row. A
//     silent overwrite would be an unaudited binding change. Note the direction that actually
//     bites: for a request that MATCHED, any id the claim already knows and the request also proves
//     is necessarily equal — so the real hazard is ERASING an id the claim knows and the request
//     does not, which the NULL-only rule prevents.
//  3. Only from the request's own server-stamped columns. `proven` is always
//     nameClaimBindingFromPublishRequest(request), whose ids come from source_github_repository_id
//     / source_github_owner_id — set from a verified OIDC claim or a GitHub App installation, never
//     from the request body. Sourcing them from anywhere else (the body; pack_ownerships) would let
//     the caller choose the pin.
//  4. Audited, as `nameClaimEnriched` on the approve row.
//
// MONOTONICITY is the safety property. Before, the claim admitted "any repo whose case-folded full
// name is F". After, it admits "the numeric repo I, whose owner id is O". The admitted set strictly
// SHRINKS; nothing is ever newly admitted. The pre-existing weak link (occupy full name F and you
// match) is untouched by enrichment and is closed going forward by it.
function nameClaimEnrichment(
  incoming: NameClaimEnrichment,
  proven: NameClaimEnrichment,
): NameClaimEnrichment | undefined {
  const githubRepositoryId = incoming.githubRepositoryId ? undefined : proven.githubRepositoryId;
  const githubOwnerId = incoming.githubOwnerId ? undefined : proven.githubOwnerId;
  if (!githubRepositoryId && !githubOwnerId) return undefined;
  return {
    ...(githubRepositoryId ? { githubRepositoryId } : {}),
    ...(githubOwnerId ? { githubOwnerId } : {}),
  };
}

// The per-name advisory lock key. Every transaction that reads-then-writes pack_name_claims takes
// it as its FIRST statement, so approve and withdraw are strictly ordered against each other for a
// given name and each sees the other's committed effect rather than a stale snapshot.
function nameClaimLockKey(name: string) {
  return `registry-name-claim:${name}`;
}

// The binding fields of a claim, for an audit record of a re-pin or a release. Timestamps are
// dropped: the audit row carries its own, and the claim's are not what moved.
function nameClaimAuditBinding(claim: Omit<PackNameClaim, "createdAt" | "updatedAt">) {
  return {
    repoFullName: claim.repoFullName,
    githubRepositoryId: claim.githubRepositoryId,
    githubOwnerId: claim.githubOwnerId,
    githubOwnerLogin: claim.githubOwnerLogin,
    claimedByUserId: claim.claimedByUserId,
    sourceRequestId: claim.sourceRequestId,
  };
}

function nameClaimFromRow(row: {
  name: string;
  scope?: string | null;
  repo_full_name: string;
  github_repository_id?: string | null;
  github_owner_id?: string | null;
  github_owner_login: string;
  claimed_by_user_id?: string | null;
  source_request_id?: string | null;
  created_at: Date | string | number;
  updated_at: Date | string | number;
}): PackNameClaim {
  return {
    name: row.name,
    scope: row.scope ?? undefined,
    repoFullName: row.repo_full_name,
    githubRepositoryId: row.github_repository_id ?? undefined,
    githubOwnerId: row.github_owner_id ?? undefined,
    githubOwnerLogin: row.github_owner_login,
    claimedByUserId: row.claimed_by_user_id ?? undefined,
    sourceRequestId: row.source_request_id ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function publishRequestStatus(value: unknown): PublishRequestRow["status"] {
  return value === "pending_review" ||
    value === "approved" ||
    value === "rejected" ||
    value === "withdrawn" ||
    value === "validation_failed" ||
    value === "pending_validation"
    ? value
    : "pending_validation";
}

// States from which validate/reject may still act. approved/withdrawn are post-serving and
// terminal to these actions (an approved publish is taken down via withdrawPublishRequest).
function isPreApprovalStatus(status: PublishRequestRow["status"]): boolean {
  return (
    status === "pending_validation" ||
    status === "validation_failed" ||
    status === "pending_review"
  );
}

// Coerce a stored submission method; unknown/legacy/NULL values map to undefined,
// which the merge gate treats as claim-only (fail-closed — never repo-proven).
function publishSubmissionMethod(value: unknown): PublishSubmissionMethod | undefined {
  return value === "web_session" ||
    value === "api_token" ||
    value === "github_actions_oidc" ||
    value === "github_import"
    ? value
    : undefined;
}

function normalizeRegistryEntry(value: unknown): PublishRegistryEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as PublishRegistryEntry;
  if (
    typeof entry.name !== "string" ||
    typeof entry.description !== "string" ||
    typeof entry.source !== "string" ||
    entry.sourceKind !== "git" ||
    !entry.release ||
    typeof entry.release.version !== "string" ||
    typeof entry.release.ref !== "string" ||
    typeof entry.release.commit !== "string" ||
    typeof entry.release.hash !== "string" ||
    typeof entry.release.description !== "string"
  ) {
    return undefined;
  }
  return entry;
}

// Is this resubmit a replay of the stored row, or a genuinely different submission? Every field the
// row carries from its input is compared — including requestedRef and requestedDescription, which
// were previously ignored, so a resubmit that only fixed the ref returned the STALE row and silently
// dropped the new value. Now that a divergent resubmit supersedes (createPublishRequest), "fix the
// ref and retry" has to actually work.
function isSamePublishRequest(left: PublishRequestRow, right: {
  repoUrl: string;
  sourceUrl: string;
  packPath: string;
  commit: string;
  requestedName: string;
  requestedVersion: string;
  requestedRef?: string;
  requestedDescription?: string;
}) {
  return (
    left.repoUrl === right.repoUrl &&
    left.sourceUrl === right.sourceUrl &&
    left.packPath === right.packPath &&
    left.commit === right.commit &&
    left.requestedName === right.requestedName &&
    left.requestedVersion === right.requestedVersion &&
    left.requestedRef === right.requestedRef &&
    left.requestedDescription === right.requestedDescription
  );
}

// The reason stamped on a row a divergent resubmit replaced. It names the superseding request, so
// the trail reads correctly with no new status and no reviewer: reviewed_by_user_id stays NULL and a
// distinct publish_request.supersede audit action is what separates this from a staff rejection.
// Rendered as-is by all three status surfaces (admin queue, /publish, /account).
function supersededStatusReason(supersededByRequestId: string) {
  return `Superseded by a newer submission from the same publisher (${supersededByRequestId}).`;
}

// WHO approved a publish request. Both store impls run one approval body and read the staff/auto
// difference off this discriminant, so an unattended approval cannot be recorded as a staff one (or
// the reverse) by passing the wrong option: the entry point picks the variant, not the caller's
// payload. A staff caller that happens to pass `autoApprove` in its decision is simply ignored.
type ApprovalActor =
  | { kind: "staff"; userId: string }
  | { kind: "auto"; context: PublishAutoApproveContext };

// The three audit keys that distinguish an unattended approval from a staff one, plus the forensics
// the OIDC token carried. Absent (not `false`, not `"staff"`) on the staff path so existing audit
// consumers see byte-identical metadata for the approvals they already understand.
function approvalAuditMetadata(actor: ApprovalActor) {
  if (actor.kind === "staff") return {};
  return {
    approvalMode: "auto" as const,
    autoApprovedFromRequestId: actor.context.precedentRequestId,
    oidcRef: actor.context.ref,
    oidcEventName: actor.context.eventName,
  };
}

function normalizeStatusReason(value: string, fallback: string) {
  const clean = value.trim().replace(/\s+/g, " ").slice(0, 500);
  if (!clean) return fallback;
  return clean;
}

function githubPublishImportFromRow(row: {
  id: string;
  user_id: string;
  repositories_scanned: number;
  private_repositories_skipped: number;
  candidates: unknown;
  scan_errors: unknown;
  truncated: boolean;
  expires_at: Date | string | number;
  created_at: Date | string | number;
}): GitHubPublishImportRow {
  return {
    id: row.id,
    userId: row.user_id,
    repositoriesScanned: Number(row.repositories_scanned) || 0,
    privateRepositoriesSkipped: Number(row.private_repositories_skipped) || 0,
    candidates: normalizeGitHubPublishCandidates(row.candidates),
    scanErrors: normalizeStringArray(row.scan_errors).slice(0, 25),
    truncated: Boolean(row.truncated),
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
  };
}

function normalizeGitHubPublishCandidates(value: unknown): GitHubPublishCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeGitHubPublishCandidate)
    .filter((candidate): candidate is GitHubPublishCandidate => Boolean(candidate))
    .slice(0, 100);
}

function normalizeGitHubPublishCandidate(value: unknown): GitHubPublishCandidate | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as GitHubPublishCandidate;
  const valid =
    typeof candidate.id === "string" &&
    typeof candidate.repository?.id === "string" &&
    typeof candidate.repository?.fullName === "string" &&
    typeof candidate.repository?.owner === "string" &&
    typeof candidate.repository?.name === "string" &&
    typeof candidate.repository?.htmlUrl === "string" &&
    typeof candidate.repository?.defaultBranch === "string" &&
    (candidate.repository?.permission === "admin" ||
      candidate.repository?.permission === "maintain" ||
      candidate.repository?.permission === "push") &&
    typeof candidate.branch === "string" &&
    typeof candidate.commit === "string" &&
    typeof candidate.packPath === "string" &&
    typeof candidate.packTomlPath === "string" &&
    typeof candidate.pack?.name === "string";
  if (!valid) return null;
  return {
    id: candidate.id,
    repository: {
      id: candidate.repository.id,
      fullName: candidate.repository.fullName,
      owner: candidate.repository.owner,
      ownerId:
        typeof candidate.repository.ownerId === "string" ? candidate.repository.ownerId : undefined,
      name: candidate.repository.name,
      htmlUrl: candidate.repository.htmlUrl,
      defaultBranch: candidate.repository.defaultBranch,
      permission: candidate.repository.permission,
    },
    branch: candidate.branch,
    commit: candidate.commit,
    packPath: candidate.packPath,
    packTomlPath: candidate.packTomlPath,
    pack: {
      name: candidate.pack.name,
      version: typeof candidate.pack.version === "string" ? candidate.pack.version : undefined,
      description: typeof candidate.pack.description === "string" ? candidate.pack.description : undefined,
    },
    warnings: normalizeStringArray(candidate.warnings),
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 500));
}

export class PostgresRegistryStore implements RegistryStore {
  readonly kind = "postgres" as const;
  private readonly sql: Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      max: 4,
      idle_timeout: 20,
      max_lifetime: 60 * 30,
      // The idempotent migrate-on-boot DDL (ALTER TABLE ... IF NOT EXISTS) emits a NOTICE per
      // already-present column; silence them so real errors aren't buried in boot/CI logs.
      onnotice: () => {},
    });
  }

  async ping() {
    await this.sql`SELECT 1`;
  }

  // Migrate-on-boot runs on EVERY app start, and instances boot concurrently, so the DDL below
  // has to be serialized across processes: `IF NOT EXISTS` is checked before the statement runs,
  // not atomically with it, so two instances creating the same table both pass the check and the
  // loser fails on pg_type's unique index. init() is awaited at top level in server/index.ts, so
  // that failure takes the instance down before it binds. A session-level advisory lock on a
  // reserved connection makes the whole migration one-at-a-time; it is released if the process
  // dies, so a crashed deploy can't wedge the next boot.
  async init() {
    const migration = await this.sql.reserve();
    try {
      await migration`SELECT pg_advisory_lock(hashtextextended('registry-migrate-on-boot', 0))`;
      await this.migrate();
    } finally {
      // Best-effort: releasing the connection drops the lock anyway.
      await migration`SELECT pg_advisory_unlock(hashtextextended('registry-migrate-on-boot', 0))`.catch(
        () => {},
      );
      migration.release();
    }
  }

  private async migrate() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        gascity_user_id text NOT NULL,
        gascity_account_id text,
        oidc_subject text,
        email text,
        handle text NOT NULL,
        display_name text NOT NULL,
        avatar_url text,
        role text NOT NULL DEFAULT 'user',
        status text NOT NULL DEFAULT 'active',
        org_member boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS gascity_user_id text`;
    await this.sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS org_member boolean NOT NULL DEFAULT false`;
    await this.sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS gascity_account_id text`;
    await this.sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_subject text`;
    await this.sql`ALTER TABLE users ALTER COLUMN gascity_account_id DROP NOT NULL`;
    await this.sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_gascity_account_id_key`;
    await this.sql`
      UPDATE users
      SET gascity_user_id = gascity_account_id
      WHERE gascity_user_id IS NULL AND gascity_account_id IS NOT NULL
    `;
    await this.sql`UPDATE users SET gascity_user_id = id WHERE gascity_user_id IS NULL`;
    await this.sql`ALTER TABLE users ALTER COLUMN gascity_user_id SET NOT NULL`;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS users_gascity_user_id_unique ON users (gascity_user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS users_gascity_account_id_idx ON users (gascity_account_id)`;
    await this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_subject_unique
      ON users (oidc_subject)
      WHERE oidc_subject IS NOT NULL
    `;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS users_handle_unique ON users (lower(handle))`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_hash text UNIQUE NOT NULL,
        csrf_token text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label text NOT NULL,
        prefix text NOT NULL,
        token_hash text UNIQUE NOT NULL,
        kind text NOT NULL DEFAULT 'personal',
        expires_at timestamptz,
        constraints jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      )
    `;
    await this.sql`ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'personal'`;
    await this.sql`ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz`;
    await this.sql`ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS constraints jsonb`;
    await this.sql`ALTER TABLE api_tokens DROP CONSTRAINT IF EXISTS api_tokens_kind_check`;
    await this.sql`
      ALTER TABLE api_tokens
      ADD CONSTRAINT api_tokens_kind_check
      CHECK (kind IN ('personal', 'github_actions_publish'))
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens (user_id, created_at DESC)`;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_token_hash_unique ON api_tokens (token_hash)`;
    await this.sql`CREATE INDEX IF NOT EXISTS api_tokens_expires_idx ON api_tokens (expires_at)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS cli_device_codes (
        id text PRIMARY KEY,
        device_code_hash text UNIQUE NOT NULL,
        user_code_hash text UNIQUE NOT NULL,
        user_id text REFERENCES users(id) ON DELETE SET NULL,
        label text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        interval_seconds integer NOT NULL DEFAULT 5,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        approved_at timestamptz,
        denied_at timestamptz,
        consumed_at timestamptz,
        last_polled_at timestamptz
      )
    `;
    await this.sql`ALTER TABLE cli_device_codes DROP CONSTRAINT IF EXISTS cli_device_codes_status_check`;
    await this.sql`
      ALTER TABLE cli_device_codes
      ADD CONSTRAINT cli_device_codes_status_check
      CHECK (status IN ('pending', 'approved', 'denied', 'consumed'))
    `;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS cli_device_codes_device_hash_unique ON cli_device_codes (device_code_hash)`;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS cli_device_codes_user_hash_unique ON cli_device_codes (user_code_hash)`;
    await this.sql`CREATE INDEX IF NOT EXISTS cli_device_codes_expires_idx ON cli_device_codes (expires_at)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS pack_reviews (
        id text PRIMARY KEY,
        pack_key text NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
        title text,
        body text NOT NULL,
        recommend boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        UNIQUE (pack_key, user_id)
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_reviews_pack_key_idx ON pack_reviews (pack_key, updated_at DESC)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS review_reports (
        id text PRIMARY KEY,
        review_id text NOT NULL REFERENCES pack_reviews(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (review_id, user_id)
      )
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS pack_stars (
        pack_key text NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (pack_key, user_id)
      )
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS publishers (
        id text PRIMARY KEY,
        handle text NOT NULL,
        display_name text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('user', 'org')),
        trusted boolean NOT NULL DEFAULT false,
        github_owner_login text,
        github_owner_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS publishers_handle_unique ON publishers (lower(handle))`;
    await this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS publishers_github_owner_id_unique
      ON publishers (github_owner_id)
      WHERE github_owner_id IS NOT NULL
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS publisher_members (
        publisher_id text NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('owner', 'admin', 'publisher')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (publisher_id, user_id)
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS publisher_members_user_idx ON publisher_members (user_id)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS pack_ownerships (
        pack_key text PRIMARY KEY,
        source_url text NOT NULL,
        publisher_id text NOT NULL REFERENCES publishers(id) ON DELETE RESTRICT,
        github_repository_id text NOT NULL,
        github_repository_full_name text NOT NULL,
        github_repository_name text NOT NULL,
        github_owner_id text NOT NULL,
        github_owner_login text NOT NULL,
        verification_method text NOT NULL,
        verified_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
        verified_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    // Defensive retrofit: the publish-ownership merge gate reads verified_by_user_id, so
    // guarantee the column exists even on databases whose pack_ownerships predates it.
    await this.sql`ALTER TABLE pack_ownerships ADD COLUMN IF NOT EXISTS verified_by_user_id text REFERENCES users(id) ON DELETE SET NULL`;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_ownerships_publisher_idx ON pack_ownerships (publisher_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_ownerships_github_repository_idx ON pack_ownerships (github_repository_id)`;
    // Index the gate's lookup (repo full name + verifier).
    await this.sql`CREATE INDEX IF NOT EXISTS pack_ownerships_repo_verifier_idx ON pack_ownerships (lower(github_repository_full_name), verified_by_user_id)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS github_publish_imports (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        repositories_scanned integer NOT NULL DEFAULT 0,
        private_repositories_skipped integer NOT NULL DEFAULT 0,
        candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
        scan_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
        truncated boolean NOT NULL DEFAULT false,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS github_publish_imports_user_idx ON github_publish_imports (user_id, created_at DESC)`;
    await this.sql`CREATE INDEX IF NOT EXISTS github_publish_imports_expires_idx ON github_publish_imports (expires_at)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS pack_publish_requests (
        id text PRIMARY KEY,
        submitter_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status text NOT NULL,
        repo_host text NOT NULL DEFAULT 'github.com',
        repo_owner text NOT NULL,
        repo_name text NOT NULL,
        repo_full_name text NOT NULL,
        repo_url text NOT NULL,
        source_url text NOT NULL,
        pack_path text NOT NULL,
        commit_sha text NOT NULL,
        requested_name text NOT NULL,
        requested_version text NOT NULL,
        requested_ref text,
        requested_description text,
        registry_entry jsonb,
        validation_error text,
        validated_at timestamptz,
        status_reason text,
        reviewed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`ALTER TABLE pack_publish_requests DROP CONSTRAINT IF EXISTS pack_publish_requests_status_check`;
    await this.sql`
      ALTER TABLE pack_publish_requests
      ADD CONSTRAINT pack_publish_requests_status_check
      CHECK (status IN ('pending_validation', 'validation_failed', 'pending_review', 'approved', 'rejected', 'withdrawn'))
    `;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS registry_entry jsonb`;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS validation_error text`;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS validated_at timestamptz`;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS reviewed_by_user_id text REFERENCES users(id) ON DELETE SET NULL`;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS reviewed_at timestamptz`;
    // Repo-proof provenance for the publish-approval merge gate. Nullable: rows that
    // predate this column read back as undefined and are treated as claim-only.
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS submission_method text`;
    // GitHub's numeric source ids, stamped from the trusted auth context at create time (see
    // PublishSourceIdentity). Nullable: claim-only submissions prove neither id.
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS source_github_repository_id text`;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS source_github_owner_id text`;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_publish_requests_submitter_idx ON pack_publish_requests (submitter_user_id, created_at DESC)`;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_publish_requests_review_idx ON pack_publish_requests (status, created_at DESC)`;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_publish_requests_pack_version_idx ON pack_publish_requests (requested_name, requested_version)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS pack_name_claims (
        name text PRIMARY KEY,
        scope text,
        repo_full_name text NOT NULL,
        github_repository_id text,
        github_owner_id text,
        github_owner_login text NOT NULL,
        claimed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
        source_request_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_name_claims_repo_idx ON pack_name_claims (lower(repo_full_name))`;
    // Grandfather every already-served name from the FIRST-APPROVED request that used it, which
    // is the same rule approvePublishRequest applies at runtime (first approval mints the claim).
    // Ordering by submission time instead would disagree with it: for two requests where the
    // earlier submission was approved later, the two rules pick different owners, so the claim
    // this deploy freezes would depend on when the deploy happened. That is unrecoverable — the
    // backfill effectively runs once, and nothing re-points a claim afterwards.
    //
    // reviewed_at is NULL only on rows approved before that column existed; those fall back to
    // submission order. `id COLLATE "C"` forces byte-wise comparison so the tiebreak cannot vary
    // with the server's collation (the FileRegistryStore mirror compares code units, not locale).
    // Idempotent, so it is safe on every boot.
    await this.sql`
      INSERT INTO pack_name_claims (
        name, scope, repo_full_name, github_repository_id, github_owner_id, github_owner_login,
        claimed_by_user_id, source_request_id
      )
      SELECT DISTINCT ON (requested_name)
        requested_name,
        CASE WHEN strpos(requested_name, '/') > 0 THEN split_part(requested_name, '/', 1) END,
        repo_full_name,
        source_github_repository_id,
        source_github_owner_id,
        repo_owner,
        submitter_user_id,
        id
      FROM pack_publish_requests
      WHERE status = 'approved'
      ORDER BY requested_name, reviewed_at ASC NULLS LAST, created_at ASC, id COLLATE "C" ASC
      ON CONFLICT (name) DO NOTHING
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id text PRIMARY KEY,
        actor_user_id text,
        action text NOT NULL,
        target_type text NOT NULL,
        target_id text NOT NULL,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  }

  async close() {
    await this.sql.end({ timeout: 5 });
  }

  async ensureUser(identity: IdentityClaims): Promise<SessionUser> {
    const now = new Date();
    const handle = normalizeHandle(identity.handle ?? identity.email?.split("@")[0]) ?? "user";
    const displayName = identity.displayName?.trim() || handle;
    const id = newId("user");
    const uniqueHandle = await this.resolveHandle(handle, id);
    return this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`registry-user-oidc:${identity.subject}`}, 0))`;
      const established = await sql`
        SELECT gascity_user_id FROM users WHERE oidc_subject = ${identity.subject} LIMIT 1
      `;
      const stableId =
        identity.gasCityUserId === identity.subject &&
        established[0]?.gascity_user_id &&
        established[0].gascity_user_id !== identity.subject
          ? String(established[0].gascity_user_id)
          : identity.gasCityUserId;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`registry-user-stable:${stableId}`}, 0))`;
      const existing = await sql`
        SELECT * FROM users
        WHERE gascity_user_id = ${stableId}
           OR oidc_subject = ${identity.subject}
        ORDER BY CASE WHEN gascity_user_id = ${stableId} THEN 0 ELSE 1 END
        FOR UPDATE
      `;
      if (existing.length > 1) {
        throw identityConvergenceConflict();
      }
      if (existing.length === 1) {
        const [updated] = await sql`
          UPDATE users
          SET gascity_user_id = ${stableId},
              gascity_account_id = ${identity.gasCityAccountId ?? null},
              oidc_subject = ${identity.subject},
              email = ${identity.email ?? null},
              handle = COALESCE(NULLIF(handle, ''), ${handle}),
              display_name = COALESCE(NULLIF(display_name, ''), ${displayName}),
              avatar_url = ${identity.avatarUrl ?? null},
              -- Staff entitlement: an auth-boundary-verified registry-staff assertion promotes to admin.
              -- Promote-only and re-checked at the row (race-safe): never downgrades, and never
              -- overrides a deliberate moderator/admin grant (preserves manual roles + de-escalations).
              role = CASE
                       WHEN ${!!identity.assertedAdmin} AND role NOT IN ('admin', 'moderator')
                       THEN 'admin' ELSE role
                     END,
              -- Org-publisher entitlement: LIVE-synced from the trusted registry-member assertion
              -- on every login (contrast the promote-only role above: role protects manual
              -- grants; org_member's only source of truth is the auth adapter, so losing it must
              -- de-provision on next login).
              org_member = ${!!identity.assertedOrgMember},
              updated_at = ${now}
          WHERE id = ${existing[0].id}
          RETURNING *
        `;
        return sessionUser(updated as any);
      }
      const [created] = await sql`
        INSERT INTO users (
          id, gascity_user_id, gascity_account_id, oidc_subject, email, handle, display_name,
          avatar_url, role, status, org_member, created_at, updated_at
        )
        VALUES (
          ${id}, ${stableId}, ${identity.gasCityAccountId ?? null}, ${identity.subject},
          ${identity.email ?? null}, ${uniqueHandle}, ${displayName}, ${identity.avatarUrl ?? null},
          ${identity.assertedAdmin ? "admin" : "user"}, 'active', ${!!identity.assertedOrgMember}, ${now}, ${now}
        )
        RETURNING *
      `;
      return sessionUser(created as any);
    });
  }

  async getOrCreateUserForEiaSubject(subject: string): Promise<SessionUser | null> {
    const id = newId("user");
    const baseHandle = normalizeHandle(subject) ?? "user";
    const handle = await this.resolveHandle(`${baseHandle.slice(0, 31)}-${id.slice(-8)}`, id);
    return this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`registry-user-stable:${subject}`}, 0))`;
      const existing = await sql`
        SELECT * FROM users WHERE gascity_user_id = ${subject} LIMIT 1 FOR UPDATE
      `;
      if (existing.length > 0) {
        const user = sessionUser(existing[0] as any);
        return user.status === "active" ? user : null;
      }
      const created = await sql`
        INSERT INTO users (
          id, gascity_user_id, handle, display_name, role, status, org_member, created_at, updated_at
        )
        VALUES (${id}, ${subject}, ${handle}, ${handle}, 'user', 'active', false, now(), now())
        RETURNING *
      `;
      const user = sessionUser(created[0] as any);
      return user.status === "active" ? user : null;
    });
  }

  async getSession(token: string): Promise<SessionRecord | null> {
    const rows = await this.sql`
      SELECT
        sessions.id,
        sessions.csrf_token,
        sessions.expires_at,
        users.id AS user_id,
        users.handle,
        users.display_name,
        users.avatar_url,
        users.email,
        users.role,
        users.status
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.session_hash = ${sha256(token)}
        AND sessions.expires_at > now()
        AND users.status = 'active'
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    void this.sql`UPDATE sessions SET last_seen_at = now() WHERE id = ${row.id}`.catch(() => {});
    return {
      id: row.id,
      csrfToken: row.csrf_token,
      expiresAt: new Date(row.expires_at),
      user: sessionUser({
        id: row.user_id,
        handle: row.handle,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        email: row.email,
        role: row.role,
        status: row.status,
      }),
    };
  }

  async createSession(userId: string) {
    const token = randomToken(36);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.sql`
      INSERT INTO sessions (id, user_id, session_hash, csrf_token, expires_at)
      VALUES (${newId("session")}, ${userId}, ${sha256(token)}, ${csrfToken}, ${expiresAt})
    `;
    return { token, csrfToken, expiresAt };
  }

  async destroySession(token: string) {
    await this.sql`DELETE FROM sessions WHERE session_hash = ${sha256(token)}`;
  }

  async getUserForApiToken(token: string): Promise<ApiTokenAuthResult | null> {
    const rows = await this.sql`
      SELECT
        api_tokens.id AS token_id,
        api_tokens.kind,
        api_tokens.constraints,
        api_tokens.last_used_at,
        users.id AS user_id,
        users.handle,
        users.display_name,
        users.avatar_url,
        users.email,
        users.role,
        users.status
      FROM api_tokens
      JOIN users ON users.id = api_tokens.user_id
      WHERE api_tokens.token_hash = ${hashApiToken(token)}
        AND api_tokens.revoked_at IS NULL
        AND (api_tokens.expires_at IS NULL OR api_tokens.expires_at > now())
        AND users.status = 'active'
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const lastUsedAt = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
    if (Date.now() - lastUsedAt >= API_TOKEN_TOUCH_MIN_INTERVAL_MS) {
      void this.sql`
        UPDATE api_tokens
        SET last_used_at = now()
        WHERE id = ${row.token_id}
          AND revoked_at IS NULL
          AND (last_used_at IS NULL OR last_used_at < now() - interval '15 minutes')
      `.catch(() => {});
    }
    return {
      tokenId: row.token_id,
      kind: normalizeApiTokenKind(row.kind),
      constraints: normalizeApiTokenConstraints(row.constraints),
      user: sessionUser({
        id: row.user_id,
        handle: row.handle,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        email: row.email,
        role: row.role,
        status: row.status,
      }),
    };
  }

  async listApiTokens(userId: string): Promise<ApiTokenRow[]> {
    const rows = await this.sql`
      SELECT id, label, prefix, kind, created_at, expires_at, last_used_at, revoked_at
      FROM api_tokens
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return rows.map((row) => apiTokenFromRow(row as any));
  }

  async createApiToken(
    userId: string,
    input: {
      label?: string;
      kind?: ApiTokenRow["kind"];
      expiresAt?: Date;
      constraints?: ApiTokenPublishConstraints;
    },
  ): Promise<ApiTokenCreateResult> {
    const label = normalizeApiTokenLabel(input.label);
    const kind = normalizeApiTokenKind(input.kind);
    const { token, prefix, tokenHash } = generateApiToken();
    const [row] = await this.sql`
      INSERT INTO api_tokens (id, user_id, label, prefix, token_hash, kind, expires_at, constraints)
      VALUES (
        ${newId("apiToken")}, ${userId}, ${label}, ${prefix}, ${tokenHash}, ${kind},
        ${input.expiresAt ?? null}, ${input.constraints ? this.sql.json(input.constraints as any) : null}
      )
      RETURNING id, label, prefix, kind, created_at, expires_at, last_used_at, revoked_at
    `;
    return { ...apiTokenFromRow(row as any), token };
  }

  async revokeApiToken(userId: string, tokenId: string): Promise<void> {
    const rows = await this.sql`
      UPDATE api_tokens
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = ${tokenId}
        AND user_id = ${userId}
      RETURNING id
    `;
    if (!rows[0]) throw new StoreValidationError("API token not found.");
  }

  async createCliDeviceCode(input: {
    deviceCode: string;
    userCode: string;
    label?: string;
    expiresAt: Date;
    intervalSeconds: number;
  }): Promise<CliDeviceCodeCreateResult> {
    const record = cliDeviceCodeFromInput(input);
    await this.sql`
      INSERT INTO cli_device_codes (
        id, device_code_hash, user_code_hash, label, status, interval_seconds, created_at, expires_at
      )
      VALUES (
        ${record.id}, ${record.deviceCodeHash}, ${record.userCodeHash}, ${record.label},
        'pending', ${record.intervalSeconds}, ${new Date(record.createdAt)}, ${new Date(record.expiresAt)}
      )
    `;
    return cliDeviceCodeCreateResult(record, input.deviceCode);
  }

  async pollCliDeviceCode(deviceCode: string): Promise<CliDevicePollResult> {
    const deviceCodeHash = hashCliDeviceCode(deviceCode);
    const rows = await this.sql`
      SELECT * FROM cli_device_codes
      WHERE device_code_hash = ${deviceCodeHash}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { status: "expired" };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { status: "expired" };
    if (row.status === "pending") {
      void this.sql`
        UPDATE cli_device_codes SET last_polled_at = now()
        WHERE id = ${row.id} AND status = 'pending'
      `.catch(() => {});
      return { status: "pending", intervalSeconds: Number(row.interval_seconds) || 5 };
    }
    if (row.status === "denied") return { status: "denied" };
    if (row.status !== "approved" || !row.user_id) return { status: "expired" };

    const token = await this.sql.begin(async (sql) => {
      const claimed = await sql`
        UPDATE cli_device_codes
        SET status = 'consumed', consumed_at = now(), last_polled_at = now()
        WHERE device_code_hash = ${deviceCodeHash}
          AND status = 'approved'
          AND expires_at > now()
          AND consumed_at IS NULL
        RETURNING id, user_id, label
      `;
      const claim = claimed[0];
      if (!claim?.user_id) return null;
      const generated = generateApiToken();
      const inserted = await sql`
        INSERT INTO api_tokens (id, user_id, label, prefix, token_hash)
        VALUES (${newId("apiToken")}, ${claim.user_id}, ${claim.label}, ${generated.prefix}, ${generated.tokenHash})
        RETURNING id, label, prefix, created_at, last_used_at, revoked_at
      `;
      await sql`
        INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata)
        VALUES (${newId("audit")}, ${claim.user_id}, 'cli_device_code.consume', 'cli_device_code', ${claim.id}, ${sql.json(
          { apiTokenId: inserted[0].id } as any,
        )})
      `;
      return { ...apiTokenFromRow(inserted[0] as any), token: generated.token };
    });
    return token ? { status: "approved", token } : { status: "expired" };
  }

  async approveCliDeviceCode(userId: string, userCode: string): Promise<void> {
    const rows = await this.sql`
      UPDATE cli_device_codes
      SET status = 'approved', user_id = ${userId}, approved_at = now()
      WHERE user_code_hash = ${hashCliUserCode(userCode)}
        AND status = 'pending'
        AND expires_at > now()
      RETURNING id
    `;
    if (!rows[0]) throw new StoreValidationError("Device code is invalid or expired.");
    await this.audit(userId, "cli_device_code.approve", "cli_device_code", rows[0].id, {});
  }

  async denyCliDeviceCode(userId: string, userCode: string): Promise<void> {
    const rows = await this.sql`
      UPDATE cli_device_codes
      SET status = 'denied', user_id = ${userId}, denied_at = now()
      WHERE user_code_hash = ${hashCliUserCode(userCode)}
        AND status = 'pending'
        AND expires_at > now()
      RETURNING id
    `;
    if (!rows[0]) throw new StoreValidationError("Device code is invalid or expired.");
    await this.audit(userId, "cli_device_code.deny", "cli_device_code", rows[0].id, {});
  }

  async updateUserProfile(
    userId: string,
    input: { displayName: string; handle?: string },
  ): Promise<SessionUser> {
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 80) {
      throw new StoreValidationError("Display name is invalid.");
    }
    const handle = input.handle ? await this.resolveHandle(input.handle, userId) : undefined;
    const rows = handle
      ? await this.sql`
          UPDATE users SET display_name = ${displayName}, handle = ${handle}, updated_at = now()
          WHERE id = ${userId}
          RETURNING *
        `
      : await this.sql`
          UPDATE users SET display_name = ${displayName}, updated_at = now()
          WHERE id = ${userId}
          RETURNING *
        `;
    if (!rows[0]) throw new Error("User not found.");
    return sessionUser(rows[0] as any);
  }

  async setUserRoleForDev(userId: string, role: "admin" | "moderator" | "user") {
    const rows = await this.sql`
      UPDATE users SET role = ${role}, updated_at = now()
      WHERE id = ${userId}
      RETURNING *
    `;
    if (!rows[0]) throw new Error("User not found.");
    return sessionUser(rows[0] as any);
  }

  async listReviews(packKey: string, viewerUserId?: string): Promise<ReviewListResult> {
    const rows = await this.sql`
      SELECT
        pack_reviews.*,
        users.id AS user_id,
        users.handle,
        users.display_name,
        users.avatar_url,
        users.email,
        users.role
      FROM pack_reviews
      JOIN users ON users.id = pack_reviews.user_id
      WHERE pack_reviews.pack_key = ${packKey}
        AND pack_reviews.deleted_at IS NULL
        AND users.status = 'active'
      ORDER BY pack_reviews.updated_at DESC
      LIMIT 100
    `;
    const reviews = rows.map((row) =>
      reviewFromRows(
        {
          id: row.id,
          pack_key: row.pack_key,
          rating: row.rating,
          title: row.title,
          body: row.body,
          recommend: row.recommend,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
        publicUser({
          id: row.user_id,
          handle: row.handle,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
          email: row.email,
          role: row.role,
        }),
        viewerUserId,
      ),
    );
    const viewerReview = viewerUserId
      ? reviews.find((review) => review.user.id === viewerUserId) ?? null
      : null;
    const viewerHasStarred = viewerUserId
      ? (await this.sql`
          SELECT 1 FROM pack_stars WHERE pack_key = ${packKey} AND user_id = ${viewerUserId} LIMIT 1
        `).length > 0
      : false;
    return { summary: summarizeReviews(reviews), reviews, viewerReview, viewerHasStarred };
  }

  async upsertReview(userId: string, input: ReviewInput): Promise<ReviewRow> {
    const normalized = validateReviewInput(input);
    const now = new Date();
    const [row] = await this.sql`
      INSERT INTO pack_reviews (
        id, pack_key, user_id, rating, title, body, recommend, created_at, updated_at, deleted_at
      )
      VALUES (
        ${newId("review")}, ${normalized.packKey}, ${userId}, ${normalized.rating},
        ${normalized.title ?? null}, ${normalized.body}, ${normalized.recommend}, ${now}, ${now}, NULL
      )
      ON CONFLICT (pack_key, user_id) DO UPDATE SET
        rating = EXCLUDED.rating,
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        recommend = EXCLUDED.recommend,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      RETURNING *
    `;
    await this.audit(userId, "review.upsert", "pack_review", row.id, { packKey: normalized.packKey });
    const [user] = await this.sql`SELECT * FROM users WHERE id = ${userId}`;
    return reviewFromRows(
      {
        id: row.id,
        pack_key: row.pack_key,
        rating: row.rating,
        title: row.title,
        body: row.body,
        recommend: row.recommend,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      publicUser(user as any),
      userId,
    );
  }

  async deleteReview(userId: string, packKey: string) {
    const [review] = await this.sql`
      UPDATE pack_reviews
      SET deleted_at = now(), updated_at = now()
      WHERE pack_key = ${packKey} AND user_id = ${userId} AND deleted_at IS NULL
      RETURNING id
    `;
    if (review) await this.audit(userId, "review.delete", "pack_review", review.id, { packKey });
  }

  async reportReview(userId: string, reviewId: string, reason: string) {
    const cleanReason = reason.trim().slice(0, 500);
    if (!cleanReason) throw new StoreValidationError("Report reason required.");
    try {
      await this.sql`
        INSERT INTO review_reports (id, review_id, user_id, reason)
        VALUES (${newId("report")}, ${reviewId}, ${userId}, ${cleanReason})
      `;
      await this.audit(userId, "review.report", "pack_review", reviewId, {});
      return { reported: true, alreadyReported: false };
    } catch (error: any) {
      if (error?.code === "23505") return { reported: false, alreadyReported: true };
      throw error;
    }
  }

  async listAccountReviews(userId: string): Promise<AccountReview[]> {
    const userRows = await this.sql`SELECT * FROM users WHERE id = ${userId}`;
    const user = publicUser(userRows[0] as any);
    const rows = await this.sql`
      SELECT * FROM pack_reviews
      WHERE user_id = ${userId} AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 100
    `;
    return rows.map((row) =>
      reviewFromRows(
        {
          id: row.id,
          pack_key: row.pack_key,
          rating: row.rating,
          title: row.title,
          body: row.body,
          recommend: row.recommend,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
        user,
        userId,
      ),
    );
  }

  async setStar(userId: string, packKey: string, starred: boolean) {
    if (starred) {
      await this.sql`
        INSERT INTO pack_stars (pack_key, user_id)
        VALUES (${packKey}, ${userId})
        ON CONFLICT (pack_key, user_id) DO NOTHING
      `;
    } else {
      await this.sql`DELETE FROM pack_stars WHERE pack_key = ${packKey} AND user_id = ${userId}`;
    }
    return { starred };
  }

  async getPackOwnership(packKey: string): Promise<PackOwnership | null> {
    const rows = await this.sql`
      SELECT
        pack_ownerships.*,
        publishers.id AS publisher_id,
        publishers.handle AS publisher_handle,
        publishers.display_name AS publisher_display_name,
        publishers.kind AS publisher_kind,
        publishers.trusted AS publisher_trusted,
        publishers.github_owner_login AS publisher_github_owner_login,
        publishers.github_owner_id AS publisher_github_owner_id
      FROM pack_ownerships
      JOIN publishers ON publishers.id = pack_ownerships.publisher_id
      WHERE pack_ownerships.pack_key = ${packKey}
      LIMIT 1
    `;
    return rows[0] ? ownershipFromRows(rows[0]) : null;
  }

  async verifiedRepoOwnershipRepositoryId(
    userId: string,
    repoFullName: string,
  ): Promise<string | null> {
    // Bind to the repo THIS user personally verified (verified_by_user_id), not org-wide
    // publisher membership — proving admin on one repo must not authorize publishing a
    // sibling repo of the same org that a teammate onboarded.
    //
    // Selects the numeric id (NOT NULL on this table) so the caller can compare the repo that was
    // actually proven against the one a name claim is pinned to, instead of trusting the mutable
    // full name this row was found by.
    const rows = await this.sql`
      SELECT github_repository_id
      FROM pack_ownerships
      WHERE lower(github_repository_full_name) = lower(${repoFullName})
        AND verified_by_user_id = ${userId}
      LIMIT 1
    `;
    return rows[0] ? String(rows[0].github_repository_id) : null;
  }

  async isOrgMember(userId: string): Promise<boolean> {
    const rows = await this.sql`SELECT org_member FROM users WHERE id = ${userId} LIMIT 1`;
    return rows[0]?.org_member === true;
  }

  async upsertVerifiedPackOwnership(
    userId: string,
    input: VerifiedPackOwnershipInput,
  ): Promise<PackOwnership> {
    // No source_url pre-check. It refused the very UPDATE the ON CONFLICT clause below is written
    // to perform, so re-verifying a pack whose catalog `source` had moved 422'd forever. What binds
    // an incoming packKey to a real pack is requirePackSource in server/app.ts, which runs before
    // both HTTP writers and measures the request against a LIVE authority (the generated catalog
    // for base packs, pack_name_claims for direct ones) rather than against a stale stored string.
    const publisher = await this.ensureGithubPublisher(input);
    const memberRole = input.githubOwnerType === "User" ? "owner" : "publisher";
    await this.sql`
      INSERT INTO publisher_members (publisher_id, user_id, role)
      VALUES (${publisher.id}, ${userId}, ${memberRole})
      ON CONFLICT (publisher_id, user_id) DO UPDATE SET
        role = CASE
          WHEN publisher_members.role = 'owner' THEN 'owner'
          WHEN publisher_members.role = 'admin' AND EXCLUDED.role <> 'owner' THEN 'admin'
          ELSE EXCLUDED.role
        END,
        updated_at = now()
    `;

    await this.sql`
      INSERT INTO pack_ownerships (
        pack_key, source_url, publisher_id, github_repository_id, github_repository_full_name,
        github_repository_name, github_owner_id, github_owner_login, verification_method,
        verified_by_user_id, verified_at, created_at, updated_at
      )
      VALUES (
        ${input.packKey}, ${input.sourceUrl}, ${publisher.id}, ${input.githubRepositoryId},
        ${input.githubRepositoryFullName}, ${input.githubRepositoryName}, ${input.githubOwnerId},
        ${input.githubOwnerLogin}, ${input.verificationMethod}, ${userId}, now(), now(), now()
      )
      ON CONFLICT (pack_key) DO UPDATE SET
        source_url = EXCLUDED.source_url,
        publisher_id = EXCLUDED.publisher_id,
        github_repository_id = EXCLUDED.github_repository_id,
        github_repository_full_name = EXCLUDED.github_repository_full_name,
        github_repository_name = EXCLUDED.github_repository_name,
        github_owner_id = EXCLUDED.github_owner_id,
        github_owner_login = EXCLUDED.github_owner_login,
        verification_method = EXCLUDED.verification_method,
        verified_by_user_id = EXCLUDED.verified_by_user_id,
        verified_at = EXCLUDED.verified_at,
        updated_at = EXCLUDED.updated_at
    `;
    await this.audit(userId, "pack_ownership.verify", "pack", input.packKey, {
      sourceUrl: input.sourceUrl,
      githubRepositoryId: input.githubRepositoryId,
      githubRepositoryFullName: input.githubRepositoryFullName,
      publisherId: publisher.id,
      verificationMethod: input.verificationMethod,
    });
    const ownership = await this.getPackOwnership(input.packKey);
    if (!ownership) throw new Error("Pack ownership verification failed.");
    return ownership;
  }

  async deletePackOwnershipsForGithubRepositoryIds(repositoryIds: string[], reason: string) {
    const ids = [...new Set(repositoryIds.filter(Boolean))];
    if (ids.length === 0) return 0;
    const rows = await this.sql`
      DELETE FROM pack_ownerships
      WHERE github_repository_id IN ${this.sql(ids)}
      RETURNING pack_key, github_repository_id
    `;
    for (const row of rows) {
      await this.auditSystem("pack_ownership.revoke", "pack", row.pack_key, {
        githubRepositoryId: row.github_repository_id,
        reason,
      });
    }
    return rows.length;
  }

  async createGitHubPublishImport(
    userId: string,
    input: GitHubPublishImportCreateInput,
  ): Promise<GitHubPublishImportRow> {
    const [row] = await this.sql`
      INSERT INTO github_publish_imports (
        id, user_id, repositories_scanned, private_repositories_skipped, candidates,
        scan_errors, truncated, expires_at
      )
      VALUES (
        ${newId("githubPublishImport")}, ${userId}, ${input.repositoriesScanned},
        ${input.privateRepositoriesSkipped}, ${this.sql.json(input.candidates as any)},
        ${this.sql.json(input.scanErrors as any)}, ${input.truncated}, ${input.expiresAt}
      )
      RETURNING *
    `;
    await this.audit(userId, "github_publish_import.create", "github_publish_import", row.id, {
      repositoriesScanned: input.repositoriesScanned,
      candidates: input.candidates.length,
      truncated: input.truncated,
    });
    return githubPublishImportFromRow(row as any);
  }

  async getGitHubPublishImport(userId: string, id: string): Promise<GitHubPublishImportRow | null> {
    void this.sql`DELETE FROM github_publish_imports WHERE expires_at <= now()`.catch(() => {});
    const rows = await this.sql`
      SELECT *
      FROM github_publish_imports
      WHERE id = ${id}
        AND user_id = ${userId}
        AND expires_at > now()
      LIMIT 1
    `;
    return rows[0] ? githubPublishImportFromRow(rows[0] as any) : null;
  }

  async createPublishRequest(
    userId: string,
    input: PublishRequestInput,
    submissionMethod: PublishSubmissionMethod,
    sourceIdentity?: PublishSourceIdentity,
  ): Promise<PublishRequestRow> {
    const normalized = normalizePublishRequestInput(input);
    // The submitter's own pre-approval row for this name+version, if a divergent resubmit is
    // replacing it. Scoped to the submitter by the dedup query below, so it can never close a row
    // belonging to somebody else.
    let superseded: PublishRequestRow | undefined;
    // Dedup is scoped to the submitter: a user's own re-submit is idempotent, but two
    // different users requesting the same name+version get distinct rows (cross-submitter
    // collisions are arbitrated by the registry.toml aggregate render at approval time).
    // This stops one user pre-occupying another's slot and lending their stamp/identity.
    const existing = await this.sql`
      SELECT
        pack_publish_requests.*,
        users.id AS user_id,
        users.handle,
        users.display_name,
        users.avatar_url,
        users.email,
        users.role
      FROM pack_publish_requests
      JOIN users ON users.id = pack_publish_requests.submitter_user_id
      WHERE pack_publish_requests.requested_name = ${normalized.requestedName}
        AND pack_publish_requests.requested_version = ${normalized.requestedVersion}
        AND pack_publish_requests.submitter_user_id = ${userId}
        AND pack_publish_requests.status NOT IN ('rejected', 'withdrawn')
      ORDER BY pack_publish_requests.created_at DESC
      LIMIT 1
    `;
    if (existing[0]) {
      const row = publishRequestFromRows(
        existing[0],
        publicUser({
          id: existing[0].user_id,
          handle: existing[0].handle,
          display_name: existing[0].display_name,
          avatar_url: existing[0].avatar_url,
          email: existing[0].email,
          role: existing[0].role,
        }),
      );
      if (isSamePublishRequest(row, normalized)) return row;
      // A divergent resubmit supersedes the submitter's own row. Which statuses that is allowed for
      // is decided in exactly ONE place — the CAS inside the transaction below. A pre-check here
      // would be a second copy of that status set which no test could kill (it can only refuse rows
      // the CAS already refuses), and the CAS also has to hold the line against a staff
      // reject/approve landing between this read and the write.
      superseded = row;
    }

    const now = new Date();
    const id = newId("publishRequest");
    // One transaction for the supersede, the INSERT and both audit rows: a predecessor must never be
    // closed without its replacement landing, and an audit row must not commit on a separate
    // connection from the action it records.
    const row = await this.sql.begin(async (sql) => {
      if (superseded) {
        // CAS, and the single definition of what supersede may touch: the pre-approval statuses.
        // An `approved` row is currently SERVED, so replacing its bits under a version pinned
        // clients already fetched stays a staff decision (withdraw plus a fresh approval) — it
        // matches no row here and the resubmit gets the same 409 it always did. Being a CAS rather
        // than a pre-check also means two concurrent divergent resubmits contend on the predecessor
        // (one wins, the loser gets an honest 409 instead of silently orphaning the row it thought
        // it replaced) and a staff reject/approve landing between the dedup SELECT and this UPDATE
        // is not overwritten.
        const [flipped] = await sql`
          UPDATE pack_publish_requests
          SET status = 'rejected',
              status_reason = ${supersededStatusReason(id)},
              updated_at = now()
          WHERE id = ${superseded.id}
            AND status IN ('pending_validation', 'validation_failed', 'pending_review')
          RETURNING id
        `;
        if (!flipped) {
          throw new StoreConflictError(
            `A publish request already exists for ${normalized.requestedName} ${normalized.requestedVersion}.`,
          );
        }
        await this.audit(
          userId,
          "publish_request.supersede",
          "publish_request",
          superseded.id,
          {
            supersededBy: id,
            previousStatus: superseded.status,
            requestedName: normalized.requestedName,
            requestedVersion: normalized.requestedVersion,
          },
          sql,
        );
      }
      const [inserted] = await sql`
        INSERT INTO pack_publish_requests (
          id, submitter_user_id, status, repo_host, repo_owner, repo_name, repo_full_name,
          repo_url, source_url, pack_path, commit_sha, requested_name, requested_version,
          requested_ref, requested_description, submission_method, source_github_repository_id,
          source_github_owner_id, created_at, updated_at
        )
        VALUES (
          ${id}, ${userId}, 'pending_validation', 'github.com',
          ${normalized.repository.owner}, ${normalized.repository.name}, ${normalized.repository.fullName},
          ${normalized.repoUrl}, ${normalized.sourceUrl}, ${normalized.packPath}, ${normalized.commit},
          ${normalized.requestedName}, ${normalized.requestedVersion}, ${normalized.requestedRef ?? null},
          ${normalized.requestedDescription ?? null}, ${submissionMethod},
          ${sourceIdentity?.githubRepositoryId ?? null}, ${sourceIdentity?.githubOwnerId ?? null},
          ${now}, ${now}
        )
        RETURNING *
      `;
      await this.audit(
        userId,
        "publish_request.create",
        "publish_request",
        inserted.id,
        {
          requestedName: normalized.requestedName,
          requestedVersion: normalized.requestedVersion,
          repoFullName: normalized.repository.fullName,
          commit: normalized.commit,
          packPath: normalized.packPath,
          submissionMethod,
          supersededRequestId: superseded?.id,
        },
        sql,
      );
      return inserted;
    });
    const [user] = await this.sql`SELECT * FROM users WHERE id = ${userId}`;
    return publishRequestFromRows(row, publicUser(user as any));
  }

  async getPublishRequest(id: string): Promise<PublishRequestRow | null> {
    const rows = await this.sql`
      SELECT
        pack_publish_requests.*,
        submitter.id AS user_id,
        submitter.handle,
        submitter.display_name,
        submitter.avatar_url,
        submitter.email,
        submitter.role,
        reviewer.id AS reviewed_by_user_id,
        reviewer.handle AS reviewed_by_handle,
        reviewer.display_name AS reviewed_by_display_name,
        reviewer.avatar_url AS reviewed_by_avatar_url,
        reviewer.email AS reviewed_by_email,
        reviewer.role AS reviewed_by_role
      FROM pack_publish_requests
      JOIN users AS submitter ON submitter.id = pack_publish_requests.submitter_user_id
      LEFT JOIN users AS reviewer ON reviewer.id = pack_publish_requests.reviewed_by_user_id
      WHERE pack_publish_requests.id = ${id}
      LIMIT 1
    `;
    return rows[0] ? publishRequestFromRows(rows[0], publicUser({
      id: rows[0].user_id,
      handle: rows[0].handle,
      display_name: rows[0].display_name,
      avatar_url: rows[0].avatar_url,
      email: rows[0].email,
      role: rows[0].role,
    })) : null;
  }

  async listAccountPublishRequests(userId: string): Promise<PublishRequestRow[]> {
    const [user] = await this.sql`SELECT * FROM users WHERE id = ${userId}`;
    if (!user) return [];
    const publicSubmitter = publicUser(user as any);
    const rows = await this.sql`
      SELECT * FROM pack_publish_requests
      WHERE submitter_user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return rows.map((row) => publishRequestFromRows(row, publicSubmitter));
  }

  async listPublishRequests(): Promise<PublishRequestRow[]> {
    const rows = await this.sql`
      SELECT
        pack_publish_requests.*,
        users.id AS user_id,
        users.handle,
        users.display_name,
        users.avatar_url,
        users.email,
        users.role
      FROM pack_publish_requests
      JOIN users ON users.id = pack_publish_requests.submitter_user_id
      ORDER BY pack_publish_requests.created_at DESC
      LIMIT 200
    `;
    return rows.map((row) =>
      publishRequestFromRows(
        row,
        publicUser({
          id: row.user_id,
          handle: row.handle,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
          email: row.email,
          role: row.role,
        }),
      ),
    );
  }

  async listApprovedPublishRequests(): Promise<PublishRequestRow[]> {
    const rows = await this.sql`
      SELECT
        pack_publish_requests.*,
        users.id AS user_id,
        users.handle,
        users.display_name,
        users.avatar_url,
        users.email,
        users.role
      FROM pack_publish_requests
      JOIN users ON users.id = pack_publish_requests.submitter_user_id
      WHERE pack_publish_requests.status = 'approved'
        AND pack_publish_requests.registry_entry IS NOT NULL
      ORDER BY pack_publish_requests.created_at ASC
      LIMIT 1000
    `;
    return rows.map((row) =>
      publishRequestFromRows(
        row,
        publicUser({
          id: row.user_id,
          handle: row.handle,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
          email: row.email,
          role: row.role,
        }),
      ),
    );
  }

  // 0-row UPDATEs on a status-guarded action are ambiguous (missing row vs wrong state);
  // disambiguate for a correct, non-misleading error.
  private async publishRequestActionError(id: string, action: string): Promise<StoreValidationError> {
    const exists = await this.getPublishRequest(id);
    return new StoreValidationError(
      exists ? `This publish request can no longer be ${action}.` : "Publish request not found.",
    );
  }

  async markPublishRequestValidated(
    id: string,
    entry: PublishRegistryEntry,
  ): Promise<PublishRequestRow> {
    // Only a pre-approval request may (re)validate — otherwise `validate` (submitter-accessible,
    // runs before the staff gate) could resurrect a withdrawn takedown or unpublish an approved release.
    const [row] = await this.sql`
      UPDATE pack_publish_requests
      SET status = 'pending_review',
          registry_entry = ${this.sql.json(entry as any)},
          validation_error = NULL,
          status_reason = NULL,
          validated_at = now(),
          updated_at = now()
      WHERE id = ${id}
        AND status IN ('pending_validation', 'validation_failed', 'pending_review')
      RETURNING id
    `;
    if (!row) throw await this.publishRequestActionError(id, "validated");
    const request = await this.getPublishRequest(id);
    if (!request) throw new Error("Publish request not found after validation.");
    return request;
  }

  async markPublishRequestValidationFailed(id: string, error: string): Promise<PublishRequestRow> {
    const reason = normalizeStatusReason(error, "Validation failed.");
    const [row] = await this.sql`
      UPDATE pack_publish_requests
      SET status = 'validation_failed',
          registry_entry = NULL,
          validated_at = NULL,
          validation_error = ${reason},
          status_reason = ${reason},
          updated_at = now()
      WHERE id = ${id}
        AND status IN ('pending_validation', 'validation_failed', 'pending_review')
      RETURNING id
    `;
    if (!row) throw await this.publishRequestActionError(id, "validated");
    const request = await this.getPublishRequest(id);
    if (!request) throw new Error("Publish request not found after validation failure.");
    return request;
  }

  async approvePublishRequest(
    actorUserId: string,
    id: string,
    options?: PublishApprovalDecision,
  ): Promise<PublishRequestRow> {
    return this.approveInternal({ kind: "staff", userId: actorUserId }, id, options);
  }

  async autoApprovePublishRequest(
    id: string,
    options: AutoPublishApprovalDecision,
  ): Promise<PublishRequestRow> {
    return this.approveInternal({ kind: "auto", context: options.autoApprove }, id, options);
  }

  // ONE approval body for both entry points. The per-name advisory lock, the atomic status flip and
  // the claim critical section (mint / re-pin / re-check / enrich) are security-relevant and were
  // reasoned about once; a second copy for the unattended path is exactly how the two would drift.
  private async approveInternal(
    actor: ApprovalActor,
    id: string,
    options?: PublishApprovalDecision,
  ): Promise<PublishRequestRow> {
    // NULL for an unattended approval: nobody reviewed it. Deliberately not the submitter, which
    // would put the publisher in reviewed_by — a field already on the wire and rendered as the
    // approving staff member. The audit row is the system of record instead.
    const actorUserId = actor.kind === "staff" ? actor.userId : null;
    // The staff path keeps blanking status_reason; the unattended path stamps the constant that all
    // three status surfaces already render, which is how an auto-approval is visible to staff.
    const statusReason = actor.kind === "auto" ? AUTO_APPROVED_STATUS_REASON : null;
    const current = await this.getPublishRequest(id);
    if (!current) throw new StoreValidationError("Publish request not found.");
    if (!current.registryEntry || current.status !== "pending_review") {
      throw new StoreValidationError("Publish request must be validated before approval.");
    }
    // One transaction for the status flip, the name claim and the audit row: a name must never
    // become served without its claim (or with a claim recorded for an approval that failed).
    // The UPDATE is atomic on the validated state — it closes the approve/approve (and
    // approve/withdraw) TOCTOU between the precheck above and this write.
    const approved = await this.sql.begin(async (sql) => {
      // Serialize the whole claim critical section per NAME, approve and withdraw alike. Row locks
      // alone cannot do this. Two reasons: (1) when the claim row does not exist yet there is
      // nothing to lock, so approve-INSERTs-while-withdraw-DELETEs is unreachable by row locking
      // by construction; (2) even when it does exist, a withdraw's survivor check
      // (`status='approved' AND id <> …`) cannot see a concurrent approve's uncommitted status flip
      // under READ COMMITTED, so it decides "no survivor", then blocks on the row lock, then
      // deletes the claim a just-committed approval is relying on — leaving a served release with
      // no claim and an audit row that misreports the pin. requested_name is never updated, so the
      // pre-read name below is a stable lock key.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${nameClaimLockKey(current.requestedName)}, 0))`;
      const [approvedRow] = await sql`
        WITH approval_clock AS (
          SELECT GREATEST(
            clock_timestamp(),
            COALESCE(
              MAX(reviewed_at) + INTERVAL '1 millisecond',
              '-infinity'::timestamptz
            )
          ) AS approved_at
          FROM pack_publish_requests
          WHERE requested_name = ${current.requestedName}
        )
        UPDATE pack_publish_requests
        SET status = 'approved',
            status_reason = ${statusReason},
            reviewed_by_user_id = ${actorUserId},
            reviewed_at = approval_clock.approved_at,
            updated_at = approval_clock.approved_at
        FROM approval_clock
        WHERE id = ${id}
          AND status = 'pending_review'
        RETURNING pack_publish_requests.id
      `;
      if (!approvedRow) return false;
      // Read-then-write, under the lock above. FOR UPDATE is redundant while every writer takes
      // the advisory lock and is kept only as a second line of defence for a future caller that
      // forgets it.
      const claim = nameClaimBindingFromPublishRequest(current);
      const [existing] = await sql`
        SELECT * FROM pack_name_claims WHERE name = ${claim.name} FOR UPDATE
      `;
      let namePin: NonNullable<PublishApprovalDecision["namePin"]>;
      let previousBinding: PackNameClaim | undefined;
      let enriched: NameClaimEnrichment | undefined;
      if (!existing) {
        // First approval of this name mints the claim.
        await sql`
          INSERT INTO pack_name_claims (
            name, scope, repo_full_name, github_repository_id, github_owner_id, github_owner_login,
            claimed_by_user_id, source_request_id
          )
          VALUES (
            ${claim.name}, ${claim.scope ?? null}, ${claim.repoFullName},
            ${claim.githubRepositoryId ?? null}, ${claim.githubOwnerId ?? null},
            ${claim.githubOwnerLogin}, ${claim.claimedByUserId ?? null}, ${claim.sourceRequestId ?? null}
          )
        `;
        namePin = "created";
      } else if (options?.namePinOverrideReason) {
        // The audited repo-migration path. The outgoing binding is read first so the audit row can
        // reconstruct exactly what moved from where to where.
        previousBinding = nameClaimFromRow(existing as any);
        await sql`
          UPDATE pack_name_claims
          SET repo_full_name = ${claim.repoFullName},
              github_repository_id = ${claim.githubRepositoryId ?? null},
              github_owner_id = ${claim.githubOwnerId ?? null},
              github_owner_login = ${claim.githubOwnerLogin},
              claimed_by_user_id = ${claim.claimedByUserId ?? null},
              source_request_id = ${claim.sourceRequestId ?? null},
              updated_at = now()
          WHERE name = ${claim.name}
        `;
        namePin = "repinned";
      } else if (!nameClaimMatchesRequest(nameClaimFromRow(existing as any), current)) {
        // The merge gate already checked this, but its read is NOT serialized against this
        // transaction: two approvals of the same scoped name from two sibling repos of one owner
        // both passed the gate, and the loser would previously merge anyway and record
        // namePin: "matched" for a claim that belongs to the sibling. Re-checking the identical
        // predicate here, under the lock, is what makes the pin authoritative rather than advisory.
        throw new StoreConflictError(
          `${claim.name} is claimed by ${String(existing.repo_full_name)}; the claim changed while this approval was in review. Re-open the request and approve again.`,
        );
      } else {
        namePin = "matched";
        // ENRICHMENT. Teach a claim the rename-stable ids it never proved, but only from a request
        // that has ALREADY satisfied that claim under the unchanged rule. See
        // nameClaimEnrichment() for the full trust model; the two structural halves of it are here:
        // this sits inside the `matched` branch (so it can never participate in an admission
        // decision), and the values come from `claim`, which is derived only from the request's
        // server-stamped columns.
        const fill = nameClaimEnrichment(
          {
            githubRepositoryId: existing.github_repository_id ?? undefined,
            githubOwnerId: existing.github_owner_id ?? undefined,
          },
          claim,
        );
        if (fill) {
          // COALESCE is a write-level restatement of "NULL columns only": even if the read above
          // were stale, the UPDATE physically cannot overwrite or erase a known id.
          await sql`
            UPDATE pack_name_claims
            SET github_repository_id = COALESCE(github_repository_id, ${fill.githubRepositoryId ?? null}),
                github_owner_id = COALESCE(github_owner_id, ${fill.githubOwnerId ?? null}),
                updated_at = now()
            WHERE name = ${claim.name}
          `;
          enriched = fill;
        }
      }
      await this.audit(
        actorUserId,
        "publish_request.approve",
        "publish_request",
        id,
        {
          requestedName: current.requestedName,
          requestedVersion: current.requestedVersion,
          submissionMethod: current.submissionMethod,
          // Present only when staff approved a claim-only request without repo proof —
          // the audited justification for the ownership override.
          ownershipOverrideReason: options?.ownershipOverrideReason,
          // How the merge gate was satisfied (repo_proven / verified_repo_ownership /
          // org_member / override) — recorded because org_member is live-synced and can
          // change post-approval.
          ownershipBasis: options?.ownershipBasis,
          namePin,
          // Re-pin forensics: the justification plus both ends of the move, so the audit alone
          // answers "who moved this name off which repo, and onto which".
          namePinOverrideReason: namePin === "repinned" ? options?.namePinOverrideReason : undefined,
          namePinFrom: previousBinding ? nameClaimAuditBinding(previousBinding) : undefined,
          namePinTo: namePin === "repinned" ? nameClaimAuditBinding(claim) : undefined,
          // Which previously-NULL ids this approval taught the claim. Present only when the write
          // actually happened. Deliberately a separate key rather than a fourth namePin value:
          // enrichment is a refinement OF "matched", not an alternative to it, and an audit
          // consumer switching on namePin must not meet an unknown case.
          nameClaimEnriched: enriched,
          // Unattended approvals only: how this row got approved with no reviewer, which served
          // release it was measured against, and the OIDC ref/event it was cut from.
          ...approvalAuditMetadata(actor),
        },
        sql,
      );
      return true;
    });
    if (!approved) throw await this.publishRequestActionError(id, "approved");
    const request = await this.getPublishRequest(id);
    if (!request) throw new Error("Publish request not found after approval.");
    return request;
  }

  async rejectPublishRequest(
    actorUserId: string,
    id: string,
    reason: string,
  ): Promise<PublishRequestRow> {
    const cleanReason = normalizeStatusReason(reason, "Rejected by registry staff.");
    // Reject is a pre-approval action; it must not stomp an approved/withdrawn row (that would
    // silently unpublish and destroy the withdraw audit trail). Takedown of an approved publish
    // is `withdrawPublishRequest`.
    const [row] = await this.sql`
      UPDATE pack_publish_requests
      SET status = 'rejected',
          status_reason = ${cleanReason},
          reviewed_by_user_id = ${actorUserId},
          reviewed_at = now(),
          updated_at = now()
      WHERE id = ${id}
        AND status IN ('pending_validation', 'validation_failed', 'pending_review')
      RETURNING id
    `;
    if (!row) throw await this.publishRequestActionError(id, "rejected");
    await this.audit(actorUserId, "publish_request.reject", "publish_request", id, {
      reason: cleanReason,
    });
    const request = await this.getPublishRequest(id);
    if (!request) throw new Error("Publish request not found after rejection.");
    return request;
  }

  async withdrawPublishRequest(
    actorUserId: string,
    id: string,
    reason: string,
    options?: PublishWithdrawOptions,
  ): Promise<PublishRequestRow> {
    const cleanReason = normalizeStatusReason(reason, "Withdrawn by registry staff.");
    // The lock key has to be known BEFORE the transaction opens, and requested_name is immutable
    // (nothing in this file ever SETs it), so this unlocked read is safe. A missing row short-
    // circuits to the same error the atomic UPDATE below would have produced.
    const [named] = await this.sql`
      SELECT requested_name FROM pack_publish_requests WHERE id = ${id} LIMIT 1
    `;
    if (!named) throw await this.publishRequestActionError(id, "withdrawn");
    const name = String(named.requested_name);
    // One transaction for the status flip, the optional claim release and the audit rows: an
    // operator who asked to free the name must not end up with a takedown and a stale claim (or
    // the reverse). Only an approved (currently-served) request can be withdrawn, and the UPDATE
    // is atomic on that state so it can't race a concurrent re-approve. registry_entry is
    // intentionally KEPT as takedown evidence + input to the post-withdraw version guard.
    const withdrawn = await this.sql.begin(async (sql) => {
      // Same per-name advisory lock approve takes, and for the same reason: without it the
      // survivor check below runs against a snapshot that cannot see a concurrent approve's
      // uncommitted status flip, so a release can delete the claim of a release that is about to
      // be served. See approvePublishRequest for the full interleaving.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${nameClaimLockKey(name)}, 0))`;
      const [row] = await sql`
        UPDATE pack_publish_requests
        SET status = 'withdrawn',
            status_reason = ${cleanReason},
            reviewed_by_user_id = ${actorUserId},
            reviewed_at = now(),
            updated_at = now()
        WHERE id = ${id}
          AND status = 'approved'
        RETURNING id
      `;
      if (!row) return false;
      let released: PackNameClaim | undefined;
      if (options?.releaseNameClaim) {
        assertNameClaimReleasable(name);
        // Refuse while any OTHER approved release of this name is still served. Two reasons, both
        // load-bearing. (1) The delete is keyed by name alone, so releasing here would drop the
        // claim protecting a sibling release — possibly one a staff re-pin deliberately moved to a
        // different repo — leaving a live, served name unclaimed and re-claimable. (2) init()'s
        // grandfather backfill re-mints a claim for any name that still has an approved request,
        // so the release would silently revert on the next boot, pinned to the FIRST-approved repo:
        // a squatter's binding restored, with no audit row for the reversion.
        const [survivor] = await sql`
          SELECT 1 FROM pack_publish_requests
          WHERE requested_name = ${name} AND status = 'approved' AND id <> ${id}
          LIMIT 1
        `;
        if (survivor) {
          throw new StoreValidationError(
            "Cannot release the name claim while another approved release of this name is still served.",
          );
        }
        const [deleted] = await sql`DELETE FROM pack_name_claims WHERE name = ${name} RETURNING *`;
        if (deleted) released = nameClaimFromRow(deleted as any);
      }
      await this.audit(
        actorUserId,
        "publish_request.withdraw",
        "publish_request",
        id,
        {
          reason: cleanReason,
          // Only present on a deliberate unclaim, and it records the binding that was dropped —
          // the name returns to unclaimed, so this row is the only record of who used to hold it.
          releasedNameClaim: released ? { name, ...nameClaimAuditBinding(released) } : undefined,
        },
        sql,
      );
      return true;
    });
    if (!withdrawn) throw await this.publishRequestActionError(id, "withdrawn");
    const request = await this.getPublishRequest(id);
    if (!request) throw new Error("Publish request not found after withdrawal.");
    return request;
  }

  async listWithdrawnPublishRequestsForVersion(name: string, version: string): Promise<PublishRequestRow[]> {
    // Scoped to the exact name@version (uses pack_publish_requests_pack_version_idx). The validator
    // pins registry_entry name/version to requested_name/requested_version, so filtering on the
    // indexed request columns captures every withdrawn row the reinstatement guard must compare —
    // with no LIMIT, so a conflicting takedown can never fall out of the window.
    const rows = await this.sql`
      SELECT
        pack_publish_requests.*,
        users.id AS user_id,
        users.handle,
        users.display_name,
        users.avatar_url,
        users.email,
        users.role
      FROM pack_publish_requests
      JOIN users ON users.id = pack_publish_requests.submitter_user_id
      WHERE pack_publish_requests.status = 'withdrawn'
        AND pack_publish_requests.requested_name = ${name}
        AND pack_publish_requests.requested_version = ${version}
      ORDER BY pack_publish_requests.created_at ASC
    `;
    return rows.map((row) =>
      publishRequestFromRows(
        row,
        publicUser({
          id: row.user_id,
          handle: row.handle,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
          email: row.email,
          role: row.role,
        }),
      ),
    );
  }

  async listStaffRefusedPublishRequestsForName(name: string): Promise<PublishRequestRow[]> {
    // BOTH refusal verbs staff have, across every version. `withdrawn` is the takedown of a served
    // release; `rejected` with a reviewer is the only "no" a QUEUED release can receive, and it has
    // to be just as durable — the dedup in createPublishRequest excludes rejected rows, so an
    // identical CI re-run of a release staff read and refused lands a brand-new pending_validation
    // row that no other clause can tell apart from a first submission.
    //
    // reviewed_by_user_id IS NOT NULL is the discriminator, and it is load-bearing: the supersede
    // CAS also writes `rejected` (see createPublishRequest) and deliberately leaves the reviewer
    // NULL, because nobody refused those bits. Without the NULL test, every publisher who ever
    // corrected a pending submission would quarantine their own name forever.
    //
    // Every version, not one: the payload a refusal was about routinely moves to the next patch
    // version. Same index prefix as the name@version lookup, same absence of a LIMIT.
    const rows = await this.sql`
      SELECT
        pack_publish_requests.*,
        users.id AS user_id,
        users.handle,
        users.display_name,
        users.avatar_url,
        users.email,
        users.role
      FROM pack_publish_requests
      JOIN users ON users.id = pack_publish_requests.submitter_user_id
      WHERE pack_publish_requests.requested_name = ${name}
        AND (
          pack_publish_requests.status = 'withdrawn'
          OR (
            pack_publish_requests.status = 'rejected'
            AND pack_publish_requests.reviewed_by_user_id IS NOT NULL
          )
        )
      ORDER BY pack_publish_requests.created_at ASC
    `;
    return rows.map((row) =>
      publishRequestFromRows(
        row,
        publicUser({
          id: row.user_id,
          handle: row.handle,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
          email: row.email,
          role: row.role,
        }),
      ),
    );
  }

  async getServedPublishPrecedent(name: string): Promise<PublishRequestRow | null> {
    // MOST RECENTLY APPROVED, not any: the row's pack_path is what a repeat release is held to, so
    // answering with an older release would let a publisher revert an established name to a stale
    // directory unattended. Ordered by reviewed_at because a staff-approved monorepo move is what
    // re-establishes the path; created_at made this a coin flip for two releases submitted in the
    // same millisecond, since the id tiebreak is byte-wise over random ids.
    // `id COLLATE "C"` breaks a genuine same-instant tie byte-wise, matching the file lane's
    // comparator — localeCompare is ICU-dependent and could disagree with SQL on the same data.
    const rows = await this.sql`
      SELECT
        pack_publish_requests.*,
        users.id AS user_id,
        users.handle,
        users.display_name,
        users.avatar_url,
        users.email,
        users.role
      FROM pack_publish_requests
      JOIN users ON users.id = pack_publish_requests.submitter_user_id
      WHERE pack_publish_requests.status = 'approved'
        AND pack_publish_requests.requested_name = ${name}
      ORDER BY COALESCE(pack_publish_requests.reviewed_at, pack_publish_requests.created_at) DESC,
               pack_publish_requests.created_at DESC,
               pack_publish_requests.id COLLATE "C" DESC
      LIMIT 1
    `;
    return rows[0]
      ? publishRequestFromRows(
          rows[0],
          publicUser({
            id: rows[0].user_id,
            handle: rows[0].handle,
            display_name: rows[0].display_name,
            avatar_url: rows[0].avatar_url,
            email: rows[0].email,
            role: rows[0].role,
          }),
        )
      : null;
  }

  async getPackNameClaim(name: string): Promise<PackNameClaim | null> {
    const rows = await this.sql`SELECT * FROM pack_name_claims WHERE name = ${name} LIMIT 1`;
    return rows[0] ? nameClaimFromRow(rows[0] as any) : null;
  }

  async listPackNameClaims(names: string[]): Promise<PackNameClaim[]> {
    const wanted = [...new Set(names)];
    // Not a guard: postgres.js renders an empty array safely (it comes back with zero rows), so
    // this only skips a pointless round trip on the common "nothing to look up" call.
    if (wanted.length === 0) return [];
    const rows = await this.sql`
      SELECT * FROM pack_name_claims WHERE name IN ${this.sql(wanted)} ORDER BY name COLLATE "C"
    `;
    return rows.map((row) => nameClaimFromRow(row as any));
  }

  async listCatalogPublisherAttributions(
    names: string[],
  ): Promise<CatalogPublisherAttribution[]> {
    const wanted = [...new Set(names)];
    if (wanted.length === 0) return [];
    const rows = await this.sql`
      SELECT
        claims.name,
        claims.github_owner_login,
        publishers.id AS publisher_id,
        publishers.display_name AS publisher_display_name,
        publishers.trusted AS publisher_trusted
      FROM pack_name_claims claims
      LEFT JOIN publishers
        ON claims.github_owner_id IS NOT NULL
       AND publishers.github_owner_id = claims.github_owner_id
      WHERE claims.name IN ${this.sql(wanted)}
      ORDER BY claims.name COLLATE "C"
    `;
    return rows.map((row) => ({
      name: String(row.name),
      publisher:
        typeof row.publisher_display_name === "string" && row.publisher_display_name.trim()
          ? row.publisher_display_name.trim()
          : String(row.github_owner_login),
      trusted: row.publisher_id != null && row.publisher_trusted === true,
    }));
  }

  async setPublisherTrustByGithubOwnerId(
    githubOwnerId: string,
    trusted: boolean,
    audit: { operator: string; reason: string },
  ): Promise<PublisherSummary> {
    const input = publisherTrustMutation(githubOwnerId, trusted, audit);
    return this.sql.begin(async (sql) => {
      const rows = await sql`
        SELECT * FROM publishers WHERE github_owner_id = ${input.ownerId} LIMIT 1 FOR UPDATE
      `;
      if (!rows[0]) {
        throw new StoreValidationError("Publisher with that GitHub owner id was not found.");
      }
      const previousTrusted = rows[0].trusted === true;
      const [updated] = await sql`
        UPDATE publishers
        SET trusted = ${input.trusted}, updated_at = now()
        WHERE id = ${rows[0].id}
        RETURNING *
      `;
      await this.audit(
        null,
        "publisher.trust.update",
        "publisher",
        String(rows[0].id),
        {
          operator: input.operator,
          reason: input.reason,
          githubOwnerId: input.ownerId,
          previousTrusted,
          trusted: input.trusted,
        },
        sql,
      );
      return publicPublisher(updated as any);
    });
  }

  private async resolveHandle(rawHandle: string | undefined, userId: string) {
    const base = normalizeHandle(rawHandle) ?? "user";
    for (let index = 1; index <= 50; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`;
      const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
      const rows = await this.sql`
        SELECT id FROM users WHERE lower(handle) = lower(${candidate}) AND id <> ${userId} LIMIT 1
      `;
      if (rows.length === 0) return candidate;
    }
    return `${base.slice(0, 31)}-${randomToken(4).toLowerCase()}`;
  }

  private async resolvePublisherHandle(rawHandle: string | undefined, publisherId: string) {
    const base = normalizePublisherHandle(rawHandle);
    for (let index = 1; index <= 50; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`;
      const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
      const rows = await this.sql`
        SELECT id FROM publishers WHERE lower(handle) = lower(${candidate}) AND id <> ${publisherId} LIMIT 1
      `;
      if (rows.length === 0) return candidate;
    }
    return `${base.slice(0, 31)}-${randomToken(4).toLowerCase()}`;
  }

  private async ensureGithubPublisher(input: VerifiedPackOwnershipInput): Promise<PublisherSummary> {
    const existing = await this.sql`
      SELECT * FROM publishers WHERE github_owner_id = ${input.githubOwnerId} LIMIT 1
    `;
    const kind = input.githubOwnerType === "Organization" ? "org" : "user";
    if (existing[0]) {
      const [updated] = await this.sql`
        UPDATE publishers
        SET github_owner_login = ${input.githubOwnerLogin},
            display_name = COALESCE(NULLIF(display_name, ''), ${input.githubOwnerLogin}),
            kind = ${kind},
            updated_at = now()
        WHERE id = ${existing[0].id}
        RETURNING *
      `;
      return publicPublisher(updated as any);
    }

    const id = newId("publisher");
    const handle = await this.resolvePublisherHandle(input.githubOwnerLogin, id);
    const [created] = await this.sql`
      INSERT INTO publishers (
        id, handle, display_name, kind, trusted, github_owner_login, github_owner_id
      )
      VALUES (
        ${id}, ${handle}, ${input.githubOwnerLogin}, ${kind}, false,
        ${input.githubOwnerLogin}, ${input.githubOwnerId}
      )
      RETURNING *
    `;
    return publicPublisher(created as any);
  }

  // `executor` lets a caller inside sql.begin write its audit row in the same transaction as
  // the action it records (approve), instead of on a separate connection that could commit alone.
  // actor_user_id is nullable (auditSystem already writes NULL), so `null` here is not a new shape:
  // it is the honest record of an action no human took — an unattended approval.
  private async audit(
    actorUserId: string | null,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
    executor: ISql = this.sql,
  ) {
    await executor`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (${newId("audit")}, ${actorUserId}, ${action}, ${targetType}, ${targetId}, ${executor.json(
        metadata as any,
      )})
    `;
  }

  private async auditSystem(
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.sql`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (${newId("audit")}, NULL, ${action}, ${targetType}, ${targetId}, ${this.sql.json(
        metadata as any,
      )})
    `;
  }
}

type FileState = {
  users: Array<
    SessionUser & { gascityUserId?: string; gascityAccountId?: string; oidcSubject?: string; orgMember?: boolean }
  >;
  sessions: Array<{ hash: string; record: Omit<SessionRecord, "expiresAt"> & { expiresAt: string } }>;
  apiTokens?: StoredApiToken[];
  cliDeviceCodes?: StoredCliDeviceCode[];
  reviews: ReviewRow[];
  reports: string[];
  stars: string[];
  publishers?: PublisherSummary[];
  publisherMembers?: Array<{ publisherId: string; userId: string; role: "owner" | "admin" | "publisher" }>;
  ownerships?: PackOwnership[];
  publishRequests?: PublishRequestRow[];
  nameClaims?: PackNameClaim[];
  githubPublishImports?: GitHubPublishImportRow[];
};

type StoredApiToken = {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  kind?: ApiTokenRow["kind"];
  tokenHash: string;
  expiresAt?: string;
  constraints?: ApiTokenPublishConstraints;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

type StoredCliDeviceCode = {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  userId?: string;
  label: string;
  status: "pending" | "approved" | "denied" | "consumed";
  intervalSeconds: number;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  deniedAt?: string;
  consumedAt?: string;
  lastPolledAt?: string;
};

class FileRegistryStore implements RegistryStore {
  readonly kind = "file" as const;
  private users = new Map<
    string,
    SessionUser & { gascityUserId: string; gascityAccountId?: string; oidcSubject?: string; orgMember?: boolean }
  >();
  private sessions = new Map<string, { record: SessionRecord; hash: string }>();
  private apiTokens = new Map<string, StoredApiToken>();
  private cliDeviceCodes = new Map<string, StoredCliDeviceCode>();
  private reviews = new Map<string, ReviewRow>();
  private reports = new Set<string>();
  private stars = new Set<string>();
  private publishers = new Map<string, PublisherSummary>();
  private publisherMembers = new Map<string, { publisherId: string; userId: string; role: "owner" | "admin" | "publisher" }>();
  private ownerships = new Map<string, PackOwnership>();
  private publishRequests = new Map<string, PublishRequestRow>();
  private nameClaims = new Map<string, PackNameClaim>();
  private githubPublishImports = new Map<string, GitHubPublishImportRow>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<FileState>;
      for (const user of raw.users ?? []) {
        const legacyUser = user as SessionUser & {
          gascityUserId?: string;
          gascityAccountId?: string;
          oidcSubject?: string;
        };
        const gascityUserId = legacyUser.gascityUserId ?? legacyUser.gascityAccountId ?? legacyUser.id;
        this.users.set(user.id, {
          ...legacyUser,
          gascityUserId,
          gascityAccountId: legacyUser.gascityAccountId,
          oidcSubject: legacyUser.oidcSubject ?? gascityUserId,
          status: user.status === "disabled" ? "disabled" : "active",
        });
      }
      for (const session of raw.sessions ?? []) {
        this.sessions.set(session.record.id, {
          hash: session.hash,
          record: {
            ...session.record,
            expiresAt: new Date(session.record.expiresAt),
          },
        });
      }
      for (const token of raw.apiTokens ?? []) this.apiTokens.set(token.id, token);
      for (const code of raw.cliDeviceCodes ?? []) this.cliDeviceCodes.set(code.id, code);
      for (const review of raw.reviews ?? []) this.reviews.set(review.id, review);
      this.reports = new Set(raw.reports ?? []);
      this.stars = new Set(raw.stars ?? []);
      for (const publisher of raw.publishers ?? []) this.publishers.set(publisher.id, publisher);
      for (const member of raw.publisherMembers ?? []) {
        this.publisherMembers.set(`${member.publisherId}:${member.userId}`, member);
      }
      for (const ownership of raw.ownerships ?? []) this.ownerships.set(ownership.packKey, ownership);
      for (const request of raw.publishRequests ?? []) {
        this.publishRequests.set(request.id, {
          ...request,
          status: publishRequestStatus(request.status),
        });
      }
      for (const claim of raw.nameClaims ?? []) this.nameClaims.set(claim.name, claim);
      for (const imported of raw.githubPublishImports ?? []) {
        if (Date.parse(imported.expiresAt) > Date.now()) {
          this.githubPublishImports.set(imported.id, {
            ...imported,
            candidates: normalizeGitHubPublishCandidates(imported.candidates),
            scanErrors: normalizeStringArray(imported.scanErrors),
          });
        }
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    // Same grandfathering as the Postgres lane: every already-approved name gets a claim from the
    // first-approved request that used it, so no existing pack has to race for its own name.
    if (this.backfillNameClaims()) await this.save();
  }

  async close() {}

  async ping() {} // file store is always ready

  async ensureUser(identity: IdentityClaims): Promise<SessionUser> {
    const oidcUser = [...this.users.values()].find(
      (user) => user.oidcSubject === identity.subject,
    );
    const stableId =
      identity.gasCityUserId === identity.subject &&
      oidcUser?.gascityUserId !== undefined &&
      oidcUser.gascityUserId !== identity.subject
        ? oidcUser.gascityUserId
        : identity.gasCityUserId;
    const stableUser = [...this.users.values()].find(
      (user) => user.gascityUserId === stableId,
    );
    if (stableUser && oidcUser && stableUser.id !== oidcUser.id) {
      throw identityConvergenceConflict();
    }
    const user = stableUser ?? oidcUser;
    if (user) {
      user.gascityUserId = stableId;
      user.gascityAccountId = identity.gasCityAccountId;
      user.oidcSubject = identity.subject;
      // Promote-only staff elevation (mirrors the Postgres store): an auth-boundary-verified
      // registry-staff assertion raises the default user role to admin, but never downgrades
      // or overrides a deliberate moderator/admin grant.
      if (identity.assertedAdmin && user.role !== "admin" && user.role !== "moderator") {
        user.role = "admin";
      }
      // Live-synced (contrast the promote-only role above): the auth adapter is the sole source
      // of truth for org membership, so losing the assertion de-provisions on next login.
      user.orgMember = !!identity.assertedOrgMember;
      await this.save();
      return user;
    }
    const handle = normalizeHandle(identity.handle ?? identity.email?.split("@")[0]) ?? "local";
    const created: SessionUser & {
      gascityUserId: string;
      gascityAccountId?: string;
      oidcSubject?: string;
      orgMember?: boolean;
    } = {
      id: newId("user"),
      gascityUserId: stableId,
      gascityAccountId: identity.gasCityAccountId,
      oidcSubject: identity.subject,
      email: identity.email,
      handle,
      displayName: identity.displayName?.trim() || handle,
      avatarUrl: identity.avatarUrl,
      role: identity.assertedAdmin ? "admin" : "user",
      status: "active",
      orgMember: !!identity.assertedOrgMember,
    };
    this.users.set(created.id, created);
    await this.save();
    return created;
  }

  async getOrCreateUserForEiaSubject(subject: string): Promise<SessionUser | null> {
    for (const user of this.users.values()) {
      if (user.gascityUserId === subject) {
        return user.status === "active" ? user : null;
      }
    }
    const id = newId("user");
    const baseHandle = normalizeHandle(subject) ?? "user";
    const handle = `${baseHandle.slice(0, 31)}-${id.slice(-8)}`;
    const user: SessionUser & {
      gascityUserId: string;
      gascityAccountId?: string;
      oidcSubject?: string;
      orgMember?: boolean;
    } = {
      id,
      gascityUserId: subject,
      handle,
      displayName: handle,
      role: "user",
      status: "active",
      orgMember: false,
    };
    this.users.set(id, user);
    await this.save();
    return user;
  }

  async getSession(token: string) {
    const hash = sha256(token);
    for (const session of this.sessions.values()) {
      if (session.hash === hash && session.record.expiresAt > new Date()) return session.record;
    }
    return null;
  }

  async createSession(userId: string) {
    const token = randomToken(36);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found.");
    const id = newId("session");
    this.sessions.set(id, {
      hash: sha256(token),
      record: { id, user, csrfToken, expiresAt },
    });
    await this.save();
    return { token, csrfToken, expiresAt };
  }

  async destroySession(token: string) {
    const hash = sha256(token);
    for (const [id, session] of this.sessions) {
      if (session.hash === hash) this.sessions.delete(id);
    }
    await this.save();
  }

  async getUserForApiToken(token: string): Promise<ApiTokenAuthResult | null> {
    const hash = hashApiToken(token);
    const now = Date.now();
    for (const stored of this.apiTokens.values()) {
      if (stored.tokenHash !== hash || stored.revokedAt) continue;
      if (stored.expiresAt && isExpiredIso(stored.expiresAt)) return null;
      const user = this.users.get(stored.userId);
      if (!user || user.status !== "active") return null;
      const lastUsedAt = stored.lastUsedAt ? Date.parse(stored.lastUsedAt) : 0;
      if (now - lastUsedAt >= API_TOKEN_TOUCH_MIN_INTERVAL_MS) {
        stored.lastUsedAt = new Date(now).toISOString();
        await this.save();
      }
      return {
        tokenId: stored.id,
        kind: normalizeApiTokenKind(stored.kind),
        constraints: normalizeApiTokenConstraints(stored.constraints),
        user,
      };
    }
    return null;
  }

  async listApiTokens(userId: string): Promise<ApiTokenRow[]> {
    return [...this.apiTokens.values()]
      .filter((token) => token.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 100)
      .map((token) => ({
        id: token.id,
        label: token.label,
        prefix: token.prefix,
        kind: normalizeApiTokenKind(token.kind),
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        lastUsedAt: token.lastUsedAt,
        revokedAt: token.revokedAt,
      }));
  }

  async createApiToken(
    userId: string,
    input: {
      label?: string;
      kind?: ApiTokenRow["kind"];
      expiresAt?: Date;
      constraints?: ApiTokenPublishConstraints;
    },
  ): Promise<ApiTokenCreateResult> {
    if (!this.users.has(userId)) throw new Error("User not found.");
    const { token, prefix, tokenHash } = generateApiToken();
    const now = new Date().toISOString();
    const id = newId("apiToken");
    const kind = normalizeApiTokenKind(input.kind);
    this.apiTokens.set(id, {
      id,
      userId,
      label: normalizeApiTokenLabel(input.label),
      prefix,
      kind,
      tokenHash,
      expiresAt: input.expiresAt?.toISOString(),
      constraints: input.constraints,
      createdAt: now,
    });
    await this.save();
    return {
      id,
      label: this.apiTokens.get(id)!.label,
      prefix,
      kind,
      token,
      expiresAt: input.expiresAt?.toISOString(),
      createdAt: now,
    };
  }

  async revokeApiToken(userId: string, tokenId: string): Promise<void> {
    const stored = this.apiTokens.get(tokenId);
    if (!stored || stored.userId !== userId) throw new StoreValidationError("API token not found.");
    if (!stored.revokedAt) {
      stored.revokedAt = new Date().toISOString();
      await this.save();
    }
  }

  async createCliDeviceCode(input: {
    deviceCode: string;
    userCode: string;
    label?: string;
    expiresAt: Date;
    intervalSeconds: number;
  }): Promise<CliDeviceCodeCreateResult> {
    const record = cliDeviceCodeFromInput(input);
    const { userCode: _userCode, ...stored } = record;
    this.cliDeviceCodes.set(stored.id, stored);
    await this.save();
    return cliDeviceCodeCreateResult(record, input.deviceCode);
  }

  async pollCliDeviceCode(deviceCode: string): Promise<CliDevicePollResult> {
    const deviceCodeHash = hashCliDeviceCode(deviceCode);
    const record = [...this.cliDeviceCodes.values()].find(
      (candidate) => candidate.deviceCodeHash === deviceCodeHash,
    );
    if (!record || isExpiredIso(record.expiresAt)) return { status: "expired" };
    if (record.status === "pending") {
      record.lastPolledAt = new Date().toISOString();
      await this.save();
      return { status: "pending", intervalSeconds: record.intervalSeconds };
    }
    if (record.status === "denied") return { status: "denied" };
    if (record.status !== "approved" || !record.userId || record.consumedAt) {
      return { status: "expired" };
    }

    const generated = generateApiToken();
    const now = new Date().toISOString();
    const tokenId = newId("apiToken");
    this.apiTokens.set(tokenId, {
      id: tokenId,
      userId: record.userId,
      label: record.label,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      createdAt: now,
    });
    record.status = "consumed";
    record.consumedAt = now;
    record.lastPolledAt = now;
    await this.save();
    return {
      status: "approved",
      token: {
        id: tokenId,
        label: record.label,
        prefix: generated.prefix,
        kind: "personal",
        token: generated.token,
        createdAt: now,
      },
    };
  }

  async approveCliDeviceCode(userId: string, userCode: string): Promise<void> {
    const userCodeHash = hashCliUserCode(userCode);
    const record = [...this.cliDeviceCodes.values()].find(
      (candidate) => candidate.userCodeHash === userCodeHash,
    );
    if (!record || record.status !== "pending" || isExpiredIso(record.expiresAt)) {
      throw new StoreValidationError("Device code is invalid or expired.");
    }
    if (!this.users.has(userId)) throw new Error("User not found.");
    record.status = "approved";
    record.userId = userId;
    record.approvedAt = new Date().toISOString();
    await this.save();
  }

  async denyCliDeviceCode(userId: string, userCode: string): Promise<void> {
    const userCodeHash = hashCliUserCode(userCode);
    const record = [...this.cliDeviceCodes.values()].find(
      (candidate) => candidate.userCodeHash === userCodeHash,
    );
    if (!record || record.status !== "pending" || isExpiredIso(record.expiresAt)) {
      throw new StoreValidationError("Device code is invalid or expired.");
    }
    if (!this.users.has(userId)) throw new Error("User not found.");
    record.status = "denied";
    record.userId = userId;
    record.deniedAt = new Date().toISOString();
    await this.save();
  }

  async updateUserProfile(userId: string, input: { displayName: string; handle?: string }) {
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found.");
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 80) {
      throw new StoreValidationError("Display name is invalid.");
    }
    user.displayName = displayName;
    if (input.handle) user.handle = normalizeHandle(input.handle) ?? user.handle;
    await this.save();
    return user;
  }

  async setUserRoleForDev(userId: string, role: "admin" | "moderator" | "user") {
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found.");
    user.role = role;
    await this.save();
    return user;
  }

  async listReviews(packKey: string, viewerUserId?: string): Promise<ReviewListResult> {
    const reviews = [...this.reviews.values()]
      .filter((review) => review.packKey === packKey)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((review) => ({ ...review, viewerCanDelete: review.user.id === viewerUserId }));
    const viewerReview = viewerUserId
      ? reviews.find((review) => review.user.id === viewerUserId) ?? null
      : null;
    return {
      summary: summarizeReviews(reviews),
      reviews,
      viewerReview,
      viewerHasStarred: viewerUserId ? this.stars.has(`${packKey}:${viewerUserId}`) : false,
    };
  }

  async upsertReview(userId: string, input: ReviewInput) {
    const normalized = validateReviewInput(input);
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found.");
    const existing = [...this.reviews.values()].find(
      (review) => review.packKey === normalized.packKey && review.user.id === userId,
    );
    const now = new Date().toISOString();
    const review: ReviewRow = {
      id: existing?.id ?? newId("review"),
      packKey: normalized.packKey,
      rating: normalized.rating,
      title: normalized.title,
      body: normalized.body,
      recommend: normalized.recommend,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      user,
      viewerCanDelete: true,
    };
    this.reviews.set(review.id, review);
    await this.save();
    return review;
  }

  async deleteReview(userId: string, packKey: string) {
    for (const [id, review] of this.reviews) {
      if (review.user.id === userId && review.packKey === packKey) this.reviews.delete(id);
    }
    await this.save();
  }

  async reportReview(userId: string, reviewId: string, reason: string) {
    if (!reason.trim()) throw new StoreValidationError("Report reason required.");
    const key = `${reviewId}:${userId}`;
    if (this.reports.has(key)) return { reported: false, alreadyReported: true };
    this.reports.add(key);
    await this.save();
    return { reported: true, alreadyReported: false };
  }

  async listAccountReviews(userId: string) {
    return [...this.reviews.values()].filter((review) => review.user.id === userId);
  }

  async setStar(userId: string, packKey: string, starred: boolean) {
    const key = `${packKey}:${userId}`;
    if (starred) this.stars.add(key);
    else this.stars.delete(key);
    await this.save();
    return { starred };
  }

  async getPackOwnership(packKey: string): Promise<PackOwnership | null> {
    return this.ownerships.get(packKey) ?? null;
  }

  async verifiedRepoOwnershipRepositoryId(
    userId: string,
    repoFullName: string,
  ): Promise<string | null> {
    // Mirror of the Postgres check: bind to the repo THIS user personally verified, not
    // org-wide publisher membership, and hand back the id that was proven.
    const target = repoFullName.toLowerCase();
    for (const ownership of this.ownerships.values()) {
      if (ownership.sourceRepository?.fullName?.toLowerCase() !== target) continue;
      if (ownership.verifiedByUserId === userId) return ownership.githubRepositoryId ?? null;
    }
    return null;
  }

  async isOrgMember(userId: string): Promise<boolean> {
    return this.users.get(userId)?.orgMember === true;
  }

  async upsertVerifiedPackOwnership(userId: string, input: VerifiedPackOwnershipInput) {
    // Mirrors the Postgres lane: no source_url pin, so re-verification follows the catalog when a
    // pack's `source` moves. See the comment there for what enforces the binding instead.
    const publisher = this.ensureGithubPublisher(input);
    const role = input.githubOwnerType === "User" ? "owner" : "publisher";
    const memberKey = `${publisher.id}:${userId}`;
    const existingMember = this.publisherMembers.get(memberKey);
    this.publisherMembers.set(memberKey, {
      publisherId: publisher.id,
      userId,
      role: existingMember?.role === "owner" || existingMember?.role === "admin" ? existingMember.role : role,
    });

    const ownership: PackOwnership = {
      packKey: input.packKey,
      sourceUrl: input.sourceUrl,
      githubRepositoryId: input.githubRepositoryId,
      sourceRepository: {
        host: "github.com",
        owner: input.githubOwnerLogin,
        name: input.githubRepositoryName,
        fullName: input.githubRepositoryFullName,
      },
      verificationStatus: "verified",
      verificationMethod: input.verificationMethod,
      verifiedAt: new Date().toISOString(),
      verifiedByUserId: userId,
      publisher,
    };
    this.ownerships.set(input.packKey, ownership);
    await this.save();
    return ownership;
  }

  async deletePackOwnershipsForGithubRepositoryIds(repositoryIds: string[], _reason: string) {
    const ids = new Set(repositoryIds);
    let deleted = 0;
    for (const [packKey, ownership] of this.ownerships) {
      if (ownership.githubRepositoryId && ids.has(ownership.githubRepositoryId)) {
        this.ownerships.delete(packKey);
        deleted += 1;
      }
    }
    if (deleted > 0) await this.save();
    return deleted;
  }

  async createGitHubPublishImport(userId: string, input: GitHubPublishImportCreateInput) {
    if (!this.users.has(userId)) throw new Error("User not found.");
    const now = new Date().toISOString();
    const imported: GitHubPublishImportRow = {
      id: newId("githubPublishImport"),
      userId,
      repositoriesScanned: input.repositoriesScanned,
      privateRepositoriesSkipped: input.privateRepositoriesSkipped,
      candidates: input.candidates,
      scanErrors: input.scanErrors.slice(0, 25),
      truncated: input.truncated,
      expiresAt: input.expiresAt.toISOString(),
      createdAt: now,
    };
    this.githubPublishImports.set(imported.id, imported);
    await this.save();
    return imported;
  }

  async getGitHubPublishImport(userId: string, id: string) {
    this.deleteExpiredGithubPublishImports();
    const imported = this.githubPublishImports.get(id);
    if (!imported || imported.userId !== userId) return null;
    if (Date.parse(imported.expiresAt) <= Date.now()) {
      this.githubPublishImports.delete(id);
      await this.save();
      return null;
    }
    return imported;
  }

  async createPublishRequest(
    userId: string,
    input: PublishRequestInput,
    submissionMethod: PublishSubmissionMethod,
    sourceIdentity?: PublishSourceIdentity,
  ): Promise<PublishRequestRow> {
    const normalized = normalizePublishRequestInput(input);
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found.");
    const existing = [...this.publishRequests.values()]
      .filter(
        (request) =>
          request.requestedName === normalized.requestedName &&
          request.requestedVersion === normalized.requestedVersion &&
          request.submittedBy.id === userId &&
          request.status !== "rejected" &&
          request.status !== "withdrawn",
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    let superseded: PublishRequestRow | undefined;
    if (existing) {
      if (isSamePublishRequest(existing, normalized)) return existing;
      // Mirrors the Postgres lane: a divergent resubmit supersedes the submitter's own
      // pre-approval row, and an approved (served) row still conflicts.
      if (!isPreApprovalStatus(existing.status)) {
        throw new StoreConflictError(
          `A publish request already exists for ${normalized.requestedName} ${normalized.requestedVersion}.`,
        );
      }
      superseded = existing;
    }

    const now = new Date().toISOString();
    const id = newId("publishRequest");
    if (superseded) {
      // reviewedBy is deliberately left absent: no staff member rejected this.
      this.publishRequests.set(superseded.id, {
        ...superseded,
        status: "rejected",
        statusReason: supersededStatusReason(id),
        updatedAt: now,
      });
    }
    const request: PublishRequestRow = {
      id,
      status: "pending_validation",
      repository: normalized.repository,
      repoUrl: normalized.repoUrl,
      sourceUrl: normalized.sourceUrl,
      packPath: normalized.packPath,
      commit: normalized.commit,
      requestedName: normalized.requestedName,
      requestedVersion: normalized.requestedVersion,
      requestedRef: normalized.requestedRef,
      requestedDescription: normalized.requestedDescription,
      createdAt: now,
      updatedAt: now,
      submittedBy: user,
      submissionMethod,
      sourceGithubRepositoryId: sourceIdentity?.githubRepositoryId,
      sourceGithubOwnerId: sourceIdentity?.githubOwnerId,
    };
    this.publishRequests.set(request.id, request);
    await this.save();
    return request;
  }

  async getPublishRequest(id: string) {
    return this.publishRequests.get(id) ?? null;
  }

  async listAccountPublishRequests(userId: string) {
    return [...this.publishRequests.values()]
      .filter((request) => request.submittedBy.id === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listPublishRequests() {
    return [...this.publishRequests.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  async listApprovedPublishRequests() {
    return [...this.publishRequests.values()]
      .filter((request) => request.status === "approved" && request.registryEntry)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async markPublishRequestValidated(id: string, entry: PublishRegistryEntry) {
    const request = this.requirePublishRequest(id);
    if (!isPreApprovalStatus(request.status)) {
      throw new StoreValidationError("This publish request can no longer be validated.");
    }
    const now = new Date().toISOString();
    const next: PublishRequestRow = {
      ...request,
      status: "pending_review",
      registryEntry: entry,
      validationError: undefined,
      statusReason: undefined,
      validatedAt: now,
      updatedAt: now,
    };
    this.publishRequests.set(id, next);
    await this.save();
    return next;
  }

  async markPublishRequestValidationFailed(id: string, error: string) {
    const request = this.requirePublishRequest(id);
    if (!isPreApprovalStatus(request.status)) {
      throw new StoreValidationError("This publish request can no longer be validated.");
    }
    const now = new Date().toISOString();
    const reason = normalizeStatusReason(error, "Validation failed.");
    const next: PublishRequestRow = {
      ...request,
      status: "validation_failed",
      registryEntry: undefined,
      validatedAt: undefined,
      validationError: reason,
      statusReason: reason,
      updatedAt: now,
    };
    this.publishRequests.set(id, next);
    await this.save();
    return next;
  }

  // The file store keeps no audit_logs (dev/test backend), so the ownership-override reason and
  // the resulting namePin are not recorded anywhere — the Postgres backend is the auditable
  // system of record. The claim EFFECTS of the decision (mint / leave / re-point) do apply here,
  // because those are state the gate reads back.
  async approvePublishRequest(
    actorUserId: string,
    id: string,
    options?: PublishApprovalDecision,
  ) {
    return this.approveInternal({ kind: "staff", userId: actorUserId }, id, options);
  }

  async autoApprovePublishRequest(id: string, options: AutoPublishApprovalDecision) {
    return this.approveInternal({ kind: "auto", context: options.autoApprove }, id, options);
  }

  private nextPublishReviewTimestamp(name: string) {
    let latest = Number.NEGATIVE_INFINITY;
    for (const candidate of this.publishRequests.values()) {
      if (candidate.requestedName !== name || !candidate.reviewedAt) continue;
      const reviewedAt = Date.parse(candidate.reviewedAt);
      if (Number.isFinite(reviewedAt)) latest = Math.max(latest, reviewedAt);
    }
    return new Date(Math.max(Date.now(), latest + 1)).toISOString();
  }

  private async approveInternal(
    actor: ApprovalActor,
    id: string,
    options?: PublishApprovalDecision,
  ) {
    const request = this.requirePublishRequest(id);
    if (!request.registryEntry || request.status !== "pending_review") {
      throw new StoreValidationError("Publish request must be validated before approval.");
    }
    // No reviewer to resolve on the unattended path, and none is recorded — mirroring the Postgres
    // lane's NULL reviewed_by_user_id rather than reporting the publisher as their own reviewer.
    const reviewer = actor.kind === "staff" ? this.users.get(actor.userId) : undefined;
    if (actor.kind === "staff" && !reviewer) throw new Error("Reviewer not found.");
    // The claim decision is taken BEFORE anything mutates, mirroring the Postgres lane where the
    // same three-way branch sits inside the approve transaction: a refused approval must leave the
    // request pending_review, which Postgres gets from rollback and this lane has to get from
    // ordering. Same predicate (nameClaimMatchesRequest) as the merge gate, so the two cannot drift.
    const existing = this.nameClaims.get(request.requestedName);
    let namePin: NonNullable<PublishApprovalDecision["namePin"]>;
    let enriched: NameClaimEnrichment | undefined;
    if (!existing) {
      namePin = "created";
    } else if (options?.namePinOverrideReason) {
      namePin = "repinned";
    } else if (!nameClaimMatchesRequest(existing, request)) {
      throw new StoreConflictError(
        `${request.requestedName} is claimed by ${existing.repoFullName}; the claim changed while this approval was in review. Re-open the request and approve again.`,
      );
    } else {
      namePin = "matched";
      // Same enrichment, same trust model, same position: inside `matched`, after the refusal.
      // The file store keeps no audit_logs, so only the claim EFFECT is mirrored here.
      enriched = nameClaimEnrichment(existing, nameClaimBindingFromPublishRequest(request));
    }
    // ISO timestamps have only millisecond precision. Preserve the serialized approval order even
    // when the wall clock does not advance, otherwise precedent selection falls through to random
    // request ids and can resurrect an older pack path.
    const now = this.nextPublishReviewTimestamp(request.requestedName);
    const next: PublishRequestRow = {
      ...request,
      status: "approved",
      // Same split as the Postgres lane: the staff path clears the reason, the unattended path
      // stamps the constant the three status surfaces render.
      statusReason: actor.kind === "auto" ? AUTO_APPROVED_STATUS_REASON : undefined,
      reviewedAt: now,
      reviewedBy: reviewer,
      updatedAt: now,
    };
    this.publishRequests.set(id, next);
    // Mirrors the Postgres claim write: mint on first approval of the name, re-point under an
    // explicit staff namePinOverrideReason (keeping the original createdAt — the claim's identity
    // is the name), otherwise leave the matched claim exactly as it is.
    if (namePin === "created") {
      this.nameClaims.set(next.requestedName, {
        ...nameClaimBindingFromPublishRequest(next),
        createdAt: now,
        updatedAt: now,
      });
    } else if (namePin === "repinned") {
      this.nameClaims.set(next.requestedName, {
        ...nameClaimBindingFromPublishRequest(next),
        createdAt: existing!.createdAt,
        updatedAt: now,
      });
    } else if (enriched) {
      // Spread `existing` first so every other binding field is carried through untouched — only
      // the columns nameClaimEnrichment picked are written.
      this.nameClaims.set(next.requestedName, { ...existing!, ...enriched, updatedAt: now });
    }
    await this.save();
    return next;
  }

  async rejectPublishRequest(actorUserId: string, id: string, reason: string) {
    const request = this.requirePublishRequest(id);
    if (!isPreApprovalStatus(request.status)) {
      throw new StoreValidationError("This publish request can no longer be rejected.");
    }
    const reviewer = this.users.get(actorUserId);
    if (!reviewer) throw new Error("Reviewer not found.");
    const now = new Date().toISOString();
    const next: PublishRequestRow = {
      ...request,
      status: "rejected",
      statusReason: normalizeStatusReason(reason, "Rejected by registry staff."),
      reviewedAt: now,
      reviewedBy: reviewer,
      updatedAt: now,
    };
    this.publishRequests.set(id, next);
    await this.save();
    return next;
  }

  async withdrawPublishRequest(
    actorUserId: string,
    id: string,
    reason: string,
    options?: PublishWithdrawOptions,
  ) {
    const request = this.requirePublishRequest(id);
    if (request.status !== "approved") {
      // Same message as the Postgres lane (publishRequestActionError) so the two stores are
      // observably identical on an invalid-state withdraw.
      throw new StoreValidationError("This publish request can no longer be withdrawn.");
    }
    const reviewer = this.users.get(actorUserId);
    if (!reviewer) throw new Error("Reviewer not found.");
    // Both release guards run BEFORE anything mutates, mirroring the Postgres lane where they sit
    // inside the withdraw transaction: a refused release must leave the request served, not take it
    // down and then fail. See assertNameClaimReleasable and the Postgres survivor check for why.
    if (options?.releaseNameClaim) {
      assertNameClaimReleasable(request.requestedName);
      const survivor = [...this.publishRequests.values()].some(
        (other) =>
          other.id !== id &&
          other.requestedName === request.requestedName &&
          other.status === "approved",
      );
      if (survivor) {
        throw new StoreValidationError(
          "Cannot release the name claim while another approved release of this name is still served.",
        );
      }
    }
    const now = new Date().toISOString();
    const next: PublishRequestRow = {
      ...request,
      status: "withdrawn",
      statusReason: normalizeStatusReason(reason, "Withdrawn by registry staff."),
      reviewedAt: now,
      reviewedBy: reviewer,
      updatedAt: now,
      // registryEntry intentionally kept as takedown evidence + version-conflict-guard input.
    };
    this.publishRequests.set(id, next);
    // Mirrors the Postgres lane's single-transaction takedown: an opt-in release drops the name's
    // claim in the same step, returning the name to unclaimed.
    if (options?.releaseNameClaim) this.nameClaims.delete(next.requestedName);
    await this.save();
    return next;
  }

  async listWithdrawnPublishRequestsForVersion(name: string, version: string) {
    return [...this.publishRequests.values()]
      .filter(
        (request) =>
          request.status === "withdrawn" &&
          request.requestedName === name &&
          request.requestedVersion === version,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listStaffRefusedPublishRequestsForName(name: string) {
    // Mirrors the Postgres lane: withdrawn rows plus rejected rows that name a reviewer. A
    // superseded row is `rejected` with no reviewer (see createPublishRequest) and must NOT match.
    return [...this.publishRequests.values()]
      .filter(
        (request) =>
          request.requestedName === name &&
          (request.status === "withdrawn" ||
            (request.status === "rejected" && request.reviewedBy != null)),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getServedPublishPrecedent(name: string) {
    // Ordered by APPROVAL, not submission: "the established pack_path" is the one a human most
    // recently blessed, which is exactly what a staff-approved monorepo move re-establishes. Ordering
    // by createdAt made the answer a coin flip whenever two releases of a name were submitted in the
    // same millisecond, because the id tiebreak below is byte-wise over random ids — so a legitimate
    // move could revert to the stale directory on a fast machine and pass on a slow one.
    //
    // Byte-wise comparison for every key, matching the Postgres lane's `COLLATE "C"` tiebreak —
    // localeCompare is ICU/locale-dependent and can order the same two ids differently from SQL.
    const byCodeUnit = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
    const approvedAt = (request: PublishRequestRow) => request.reviewedAt ?? request.createdAt;
    return (
      [...this.publishRequests.values()]
        .filter((request) => request.status === "approved" && request.requestedName === name)
        .sort(
          (left, right) =>
            byCodeUnit(approvedAt(right), approvedAt(left)) ||
            byCodeUnit(right.createdAt, left.createdAt) ||
            byCodeUnit(right.id, left.id),
        )[0] ?? null
    );
  }

  async getPackNameClaim(name: string): Promise<PackNameClaim | null> {
    const claim = this.nameClaims.get(name);
    // Snapshot, not the live map entry: PostgresRegistryStore builds a fresh object per call, and
    // handing out a reference lets a caller mutate stored state (and makes any test that re-reads
    // to prove a claim did NOT change compare an object with itself).
    return claim ? { ...claim } : null;
  }

  async listPackNameClaims(names: string[]): Promise<PackNameClaim[]> {
    // Byte-wise sort to match the Postgres lane's `COLLATE "C"` — localeCompare is ICU/locale
    // dependent and would order the same two names differently from SQL. Snapshots, for the same
    // reason getPackNameClaim copies.
    return [...new Set(names)]
      .map((name) => this.nameClaims.get(name))
      .filter((claim): claim is PackNameClaim => claim != null)
      .map((claim) => ({ ...claim }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }

  async listCatalogPublisherAttributions(
    names: string[],
  ): Promise<CatalogPublisherAttribution[]> {
    return [...new Set(names)]
      .map((name) => this.nameClaims.get(name))
      .filter((claim): claim is PackNameClaim => claim != null)
      .map((claim) => {
        const publisher = claim.githubOwnerId
          ? [...this.publishers.values()].find(
              (candidate) => candidate.githubOwnerId === claim.githubOwnerId,
            )
          : undefined;
        return {
          name: claim.name,
          publisher: publisher?.displayName.trim() || claim.githubOwnerLogin,
          trusted: publisher?.trusted === true,
        };
      })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }

  async setPublisherTrustByGithubOwnerId(
    githubOwnerId: string,
    trusted: boolean,
    audit: { operator: string; reason: string },
  ): Promise<PublisherSummary> {
    const input = publisherTrustMutation(githubOwnerId, trusted, audit);
    const publisher = [...this.publishers.values()].find(
      (candidate) => candidate.githubOwnerId === input.ownerId,
    );
    if (!publisher) {
      throw new StoreValidationError("Publisher with that GitHub owner id was not found.");
    }
    const updated = { ...publisher, trusted: input.trusted };
    this.publishers.set(updated.id, updated);
    await this.save();
    return { ...updated };
  }

  // Mirror of the Postgres backfill: first-APPROVED request per name wins, tie-broken by
  // submission time then byte-wise id. `localeCompare` is deliberately avoided — its ordering is
  // ICU/locale-dependent, so it can disagree with the SQL lane's `COLLATE "C"` on the same data.
  private backfillNameClaims() {
    const now = new Date().toISOString();
    let derived = false;
    const byCodeUnit = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
    const approved = [...this.publishRequests.values()]
      .filter((request) => request.status === "approved")
      .sort(
        (left, right) =>
          // `reviewed_at ASC NULLS LAST`: a row with a recorded review time always sorts ahead of
          // one without, rather than falling back to its submission time and interleaving.
          Number(!left.reviewedAt) - Number(!right.reviewedAt) ||
          byCodeUnit(left.reviewedAt ?? "", right.reviewedAt ?? "") ||
          byCodeUnit(left.createdAt, right.createdAt) ||
          byCodeUnit(left.id, right.id),
      );
    for (const request of approved) {
      if (this.nameClaims.has(request.requestedName)) continue;
      this.nameClaims.set(request.requestedName, {
        ...nameClaimBindingFromPublishRequest(request),
        createdAt: now,
        updatedAt: now,
      });
      derived = true;
    }
    return derived;
  }

  private async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const state: FileState = {
      users: [...this.users.values()],
      sessions: [...this.sessions.values()].map((session) => ({
        hash: session.hash,
        record: {
          ...session.record,
          expiresAt: session.record.expiresAt.toISOString(),
        },
      })),
      apiTokens: [...this.apiTokens.values()],
      cliDeviceCodes: [...this.cliDeviceCodes.values()],
      reviews: [...this.reviews.values()],
      reports: [...this.reports],
      stars: [...this.stars],
      publishers: [...this.publishers.values()],
      publisherMembers: [...this.publisherMembers.values()],
      ownerships: [...this.ownerships.values()],
      publishRequests: [...this.publishRequests.values()],
      nameClaims: [...this.nameClaims.values()],
      githubPublishImports: [...this.githubPublishImports.values()].filter(
        (imported) => Date.parse(imported.expiresAt) > Date.now(),
      ),
    };
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private requirePublishRequest(id: string) {
    const request = this.publishRequests.get(id);
    if (!request) throw new StoreValidationError("Publish request not found.");
    return request;
  }

  private deleteExpiredGithubPublishImports() {
    const now = Date.now();
    for (const [id, imported] of this.githubPublishImports) {
      if (Date.parse(imported.expiresAt) <= now) this.githubPublishImports.delete(id);
    }
  }

  private ensureGithubPublisher(input: VerifiedPackOwnershipInput): PublisherSummary {
    const existing = [...this.publishers.values()].find(
      (publisher) => publisher.githubOwnerId === input.githubOwnerId,
    );
    const kind = input.githubOwnerType === "Organization" ? "org" : "user";
    if (existing) {
      existing.githubOwnerLogin = input.githubOwnerLogin;
      existing.displayName = existing.displayName || input.githubOwnerLogin;
      existing.kind = kind;
      this.publishers.set(existing.id, existing);
      return existing;
    }

    const id = newId("publisher");
    const base = normalizePublisherHandle(input.githubOwnerLogin);
    const taken = new Set([...this.publishers.values()].map((publisher) => publisher.handle));
    let handle = base;
    for (let index = 2; taken.has(handle); index += 1) {
      const suffix = `-${index}`;
      handle = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    }
    const publisher: PublisherSummary = {
      id,
      handle,
      displayName: input.githubOwnerLogin,
      kind,
      trusted: false,
      githubOwnerLogin: input.githubOwnerLogin,
      githubOwnerId: input.githubOwnerId,
    };
    this.publishers.set(id, publisher);
    return publisher;
  }
}

function summarizeReviews(reviews: ReviewRow[]) {
  if (reviews.length === 0) {
    return { count: 0, averageRating: null, recommendCount: 0 };
  }
  const total = reviews.reduce((sum, review) => sum + review.rating, 0);
  return {
    count: reviews.length,
    averageRating: Math.round((total / reviews.length) * 10) / 10,
    recommendCount: reviews.filter((review) => review.recommend).length,
  };
}

export class StoreValidationError extends Error {
  readonly status = 422;
  readonly code = "VALIDATION_ERROR";
}

export class StoreConflictError extends Error {
  readonly status = 409;
  readonly code = "CONFLICT";
}
