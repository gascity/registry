import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import postgres, { type Sql } from "postgres";
import { randomToken, sha256 } from "./crypto";
import { normalizePublishRequestInput } from "./publish";
import { generateApiToken, hashApiToken } from "./tokens";
import type {
  AccountReview,
  ApiTokenAuthResult,
  ApiTokenCreateResult,
  ApiTokenRow,
  IdentityClaims,
  PackOwnership,
  PublisherSummary,
  PublishRegistryEntry,
  PublishRequestInput,
  PublishRequestRow,
  PublicUser,
  RegistryStore,
  ReviewInput,
  ReviewListResult,
  ReviewRow,
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
  review: "rev",
  report: "rpt",
  audit: "aud",
  publisher: "pub",
  publishRequest: "prq",
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

function apiTokenFromRow(row: {
  id: string;
  label: string;
  prefix: string;
  created_at: Date | string | number;
  last_used_at?: Date | string | number | null;
  revoked_at?: Date | string | number | null;
}): ApiTokenRow {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    createdAt: toIso(row.created_at),
    lastUsedAt: row.last_used_at ? toIso(row.last_used_at) : undefined,
    revokedAt: row.revoked_at ? toIso(row.revoked_at) : undefined,
  };
}

function normalizeApiTokenLabel(value: string | undefined) {
  const label = value?.trim().replace(/\s+/g, " ").slice(0, 120);
  return label || "CLI token";
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
  };
}

function publishRequestStatus(value: unknown): PublishRequestRow["status"] {
  return value === "pending_review" ||
    value === "approved" ||
    value === "rejected" ||
    value === "validation_failed" ||
    value === "pending_validation"
    ? value
    : "pending_validation";
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

function isSamePublishRequest(left: PublishRequestRow, right: {
  repoUrl: string;
  sourceUrl: string;
  packPath: string;
  commit: string;
  requestedName: string;
  requestedVersion: string;
}) {
  return (
    left.repoUrl === right.repoUrl &&
    left.sourceUrl === right.sourceUrl &&
    left.packPath === right.packPath &&
    left.commit === right.commit &&
    left.requestedName === right.requestedName &&
    left.requestedVersion === right.requestedVersion
  );
}

function normalizeStatusReason(value: string, fallback: string) {
  const clean = value.trim().replace(/\s+/g, " ").slice(0, 500);
  if (!clean) return fallback;
  return clean;
}

export class PostgresRegistryStore implements RegistryStore {
  readonly kind = "postgres" as const;
  private readonly sql: Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      max: 4,
      idle_timeout: 20,
      max_lifetime: 60 * 30,
    });
  }

  async init() {
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
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS gascity_user_id text`;
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
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens (user_id, created_at DESC)`;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_token_hash_unique ON api_tokens (token_hash)`;
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
    await this.sql`CREATE INDEX IF NOT EXISTS pack_ownerships_publisher_idx ON pack_ownerships (publisher_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_ownerships_github_repository_idx ON pack_ownerships (github_repository_id)`;
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
      CHECK (status IN ('pending_validation', 'validation_failed', 'pending_review', 'approved', 'rejected'))
    `;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS registry_entry jsonb`;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS validation_error text`;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS validated_at timestamptz`;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS reviewed_by_user_id text REFERENCES users(id) ON DELETE SET NULL`;
    await this.sql`ALTER TABLE pack_publish_requests ADD COLUMN IF NOT EXISTS reviewed_at timestamptz`;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_publish_requests_submitter_idx ON pack_publish_requests (submitter_user_id, created_at DESC)`;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_publish_requests_review_idx ON pack_publish_requests (status, created_at DESC)`;
    await this.sql`CREATE INDEX IF NOT EXISTS pack_publish_requests_pack_version_idx ON pack_publish_requests (requested_name, requested_version)`;
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
    const existing = await this.sql`
      SELECT * FROM users
      WHERE gascity_user_id = ${identity.gasCityUserId}
         OR oidc_subject = ${identity.subject}
      ORDER BY CASE WHEN gascity_user_id = ${identity.gasCityUserId} THEN 0 ELSE 1 END
      LIMIT 1
    `;
    const now = new Date();
    const handle = normalizeHandle(identity.handle ?? identity.email?.split("@")[0]) ?? "user";
    const displayName = identity.displayName?.trim() || handle;
    if (existing.length > 0) {
      const [updated] = await this.sql`
        UPDATE users
        SET gascity_user_id = ${identity.gasCityUserId},
            gascity_account_id = ${identity.gasCityAccountId ?? null},
            oidc_subject = ${identity.subject},
            email = ${identity.email ?? null},
            handle = COALESCE(NULLIF(handle, ''), ${handle}),
            display_name = COALESCE(NULLIF(display_name, ''), ${displayName}),
            avatar_url = ${identity.avatarUrl ?? null},
            updated_at = ${now}
        WHERE id = ${existing[0].id}
        RETURNING *
      `;
      return sessionUser(updated as any);
    }
    const id = newId("user");
    const uniqueHandle = await this.resolveHandle(handle, id);
    const [created] = await this.sql`
      INSERT INTO users (
        id, gascity_user_id, gascity_account_id, oidc_subject, email, handle, display_name,
        avatar_url, role, status, created_at, updated_at
      )
      VALUES (
        ${id}, ${identity.gasCityUserId}, ${identity.gasCityAccountId ?? null}, ${identity.subject},
        ${identity.email ?? null}, ${uniqueHandle}, ${displayName}, ${identity.avatarUrl ?? null},
        'user', 'active', ${now}, ${now}
      )
      RETURNING *
    `;
    return sessionUser(created as any);
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
      SELECT id, label, prefix, created_at, last_used_at, revoked_at
      FROM api_tokens
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return rows.map((row) => apiTokenFromRow(row as any));
  }

  async createApiToken(
    userId: string,
    input: { label?: string },
  ): Promise<ApiTokenCreateResult> {
    const label = normalizeApiTokenLabel(input.label);
    const { token, prefix, tokenHash } = generateApiToken();
    const [row] = await this.sql`
      INSERT INTO api_tokens (id, user_id, label, prefix, token_hash)
      VALUES (${newId("apiToken")}, ${userId}, ${label}, ${prefix}, ${tokenHash})
      RETURNING id, label, prefix, created_at, last_used_at, revoked_at
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

  async getPackOwnership(packKey: string, sourceUrl: string): Promise<PackOwnership | null> {
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
        AND pack_ownerships.source_url = ${sourceUrl}
      LIMIT 1
    `;
    return rows[0] ? ownershipFromRows(rows[0]) : null;
  }

  async upsertVerifiedPackOwnership(
    userId: string,
    input: VerifiedPackOwnershipInput,
  ): Promise<PackOwnership> {
    const existing = await this.sql`
      SELECT source_url FROM pack_ownerships WHERE pack_key = ${input.packKey} LIMIT 1
    `;
    if (existing[0] && existing[0].source_url !== input.sourceUrl) {
      throw new StoreValidationError("Pack ownership source does not match the catalog.");
    }

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
    const ownership = await this.getPackOwnership(input.packKey, input.sourceUrl);
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

  async createPublishRequest(
    userId: string,
    input: PublishRequestInput,
  ): Promise<PublishRequestRow> {
    const normalized = normalizePublishRequestInput(input);
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
      WHERE requested_name = ${normalized.requestedName}
        AND requested_version = ${normalized.requestedVersion}
        AND status <> 'rejected'
      ORDER BY created_at DESC
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
      throw new StoreConflictError(
        `A publish request already exists for ${normalized.requestedName} ${normalized.requestedVersion}.`,
      );
    }

    const now = new Date();
    const [row] = await this.sql`
      INSERT INTO pack_publish_requests (
        id, submitter_user_id, status, repo_host, repo_owner, repo_name, repo_full_name,
        repo_url, source_url, pack_path, commit_sha, requested_name, requested_version,
        requested_ref, requested_description, created_at, updated_at
      )
      VALUES (
        ${newId("publishRequest")}, ${userId}, 'pending_validation', 'github.com',
        ${normalized.repository.owner}, ${normalized.repository.name}, ${normalized.repository.fullName},
        ${normalized.repoUrl}, ${normalized.sourceUrl}, ${normalized.packPath}, ${normalized.commit},
        ${normalized.requestedName}, ${normalized.requestedVersion}, ${normalized.requestedRef ?? null},
        ${normalized.requestedDescription ?? null}, ${now}, ${now}
      )
      RETURNING *
    `;
    await this.audit(userId, "publish_request.create", "publish_request", row.id, {
      requestedName: normalized.requestedName,
      requestedVersion: normalized.requestedVersion,
      repoFullName: normalized.repository.fullName,
      commit: normalized.commit,
      packPath: normalized.packPath,
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

  async markPublishRequestValidated(
    id: string,
    entry: PublishRegistryEntry,
  ): Promise<PublishRequestRow> {
    const [row] = await this.sql`
      UPDATE pack_publish_requests
      SET status = 'pending_review',
          registry_entry = ${this.sql.json(entry as any)},
          validation_error = NULL,
          validated_at = now(),
          updated_at = now()
      WHERE id = ${id}
      RETURNING id
    `;
    if (!row) throw new StoreValidationError("Publish request not found.");
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
      RETURNING id
    `;
    if (!row) throw new StoreValidationError("Publish request not found.");
    const request = await this.getPublishRequest(id);
    if (!request) throw new Error("Publish request not found after validation failure.");
    return request;
  }

  async approvePublishRequest(actorUserId: string, id: string): Promise<PublishRequestRow> {
    const current = await this.getPublishRequest(id);
    if (!current) throw new StoreValidationError("Publish request not found.");
    if (!current.registryEntry || current.status !== "pending_review") {
      throw new StoreValidationError("Publish request must be validated before approval.");
    }
    await this.sql`
      UPDATE pack_publish_requests
      SET status = 'approved',
          status_reason = NULL,
          reviewed_by_user_id = ${actorUserId},
          reviewed_at = now(),
          updated_at = now()
      WHERE id = ${id}
    `;
    await this.audit(actorUserId, "publish_request.approve", "publish_request", id, {
      requestedName: current.requestedName,
      requestedVersion: current.requestedVersion,
    });
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
    const [row] = await this.sql`
      UPDATE pack_publish_requests
      SET status = 'rejected',
          status_reason = ${cleanReason},
          reviewed_by_user_id = ${actorUserId},
          reviewed_at = now(),
          updated_at = now()
      WHERE id = ${id}
      RETURNING id
    `;
    if (!row) throw new StoreValidationError("Publish request not found.");
    await this.audit(actorUserId, "publish_request.reject", "publish_request", id, {
      reason: cleanReason,
    });
    const request = await this.getPublishRequest(id);
    if (!request) throw new Error("Publish request not found after rejection.");
    return request;
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

  private async audit(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.sql`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (${newId("audit")}, ${actorUserId}, ${action}, ${targetType}, ${targetId}, ${this.sql.json(
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
  users: Array<SessionUser & { gascityUserId?: string; gascityAccountId?: string; oidcSubject?: string }>;
  sessions: Array<{ hash: string; record: Omit<SessionRecord, "expiresAt"> & { expiresAt: string } }>;
  apiTokens?: StoredApiToken[];
  reviews: ReviewRow[];
  reports: string[];
  stars: string[];
  publishers?: PublisherSummary[];
  publisherMembers?: Array<{ publisherId: string; userId: string; role: "owner" | "admin" | "publisher" }>;
  ownerships?: PackOwnership[];
  publishRequests?: PublishRequestRow[];
};

type StoredApiToken = {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

class FileRegistryStore implements RegistryStore {
  readonly kind = "file" as const;
  private users = new Map<
    string,
    SessionUser & { gascityUserId: string; gascityAccountId?: string; oidcSubject?: string }
  >();
  private sessions = new Map<string, { record: SessionRecord; hash: string }>();
  private apiTokens = new Map<string, StoredApiToken>();
  private reviews = new Map<string, ReviewRow>();
  private reports = new Set<string>();
  private stars = new Set<string>();
  private publishers = new Map<string, PublisherSummary>();
  private publisherMembers = new Map<string, { publisherId: string; userId: string; role: "owner" | "admin" | "publisher" }>();
  private ownerships = new Map<string, PackOwnership>();
  private publishRequests = new Map<string, PublishRequestRow>();
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
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async close() {}

  async ensureUser(identity: IdentityClaims): Promise<SessionUser> {
    for (const user of this.users.values()) {
      if (user.gascityUserId === identity.gasCityUserId || user.oidcSubject === identity.subject) {
        user.gascityUserId = identity.gasCityUserId;
        user.gascityAccountId = identity.gasCityAccountId;
        user.oidcSubject = identity.subject;
        await this.save();
        return user;
      }
    }
    const handle = normalizeHandle(identity.handle ?? identity.email?.split("@")[0]) ?? "local";
    const user: SessionUser & { gascityUserId: string; gascityAccountId?: string; oidcSubject?: string } = {
      id: newId("user"),
      gascityUserId: identity.gasCityUserId,
      gascityAccountId: identity.gasCityAccountId,
      oidcSubject: identity.subject,
      email: identity.email,
      handle,
      displayName: identity.displayName?.trim() || handle,
      avatarUrl: identity.avatarUrl,
      role: "user",
      status: "active",
    };
    this.users.set(user.id, user);
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
      const user = this.users.get(stored.userId);
      if (!user || user.status !== "active") return null;
      const lastUsedAt = stored.lastUsedAt ? Date.parse(stored.lastUsedAt) : 0;
      if (now - lastUsedAt >= API_TOKEN_TOUCH_MIN_INTERVAL_MS) {
        stored.lastUsedAt = new Date(now).toISOString();
        await this.save();
      }
      return { tokenId: stored.id, user };
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
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        revokedAt: token.revokedAt,
      }));
  }

  async createApiToken(
    userId: string,
    input: { label?: string },
  ): Promise<ApiTokenCreateResult> {
    if (!this.users.has(userId)) throw new Error("User not found.");
    const { token, prefix, tokenHash } = generateApiToken();
    const now = new Date().toISOString();
    const id = newId("apiToken");
    this.apiTokens.set(id, {
      id,
      userId,
      label: normalizeApiTokenLabel(input.label),
      prefix,
      tokenHash,
      createdAt: now,
    });
    await this.save();
    return {
      id,
      label: this.apiTokens.get(id)!.label,
      prefix,
      token,
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

  async getPackOwnership(packKey: string, sourceUrl: string): Promise<PackOwnership | null> {
    const ownership = this.ownerships.get(packKey);
    if (!ownership || ownership.sourceUrl !== sourceUrl) return null;
    return ownership;
  }

  async upsertVerifiedPackOwnership(userId: string, input: VerifiedPackOwnershipInput) {
    const existing = this.ownerships.get(input.packKey);
    if (existing && existing.sourceUrl !== input.sourceUrl) {
      throw new StoreValidationError("Pack ownership source does not match the catalog.");
    }

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

  async createPublishRequest(userId: string, input: PublishRequestInput): Promise<PublishRequestRow> {
    const normalized = normalizePublishRequestInput(input);
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found.");
    const existing = [...this.publishRequests.values()]
      .filter(
        (request) =>
          request.requestedName === normalized.requestedName &&
          request.requestedVersion === normalized.requestedVersion &&
          request.status !== "rejected",
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (existing) {
      if (isSamePublishRequest(existing, normalized)) return existing;
      throw new StoreConflictError(
        `A publish request already exists for ${normalized.requestedName} ${normalized.requestedVersion}.`,
      );
    }

    const now = new Date().toISOString();
    const request: PublishRequestRow = {
      id: newId("publishRequest"),
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

  async approvePublishRequest(actorUserId: string, id: string) {
    const request = this.requirePublishRequest(id);
    if (!request.registryEntry || request.status !== "pending_review") {
      throw new StoreValidationError("Publish request must be validated before approval.");
    }
    const reviewer = this.users.get(actorUserId);
    if (!reviewer) throw new Error("Reviewer not found.");
    const now = new Date().toISOString();
    const next: PublishRequestRow = {
      ...request,
      status: "approved",
      statusReason: undefined,
      reviewedAt: now,
      reviewedBy: reviewer,
      updatedAt: now,
    };
    this.publishRequests.set(id, next);
    await this.save();
    return next;
  }

  async rejectPublishRequest(actorUserId: string, id: string, reason: string) {
    const request = this.requirePublishRequest(id);
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
      reviews: [...this.reviews.values()],
      reports: [...this.reports],
      stars: [...this.stars],
      publishers: [...this.publishers.values()],
      publisherMembers: [...this.publisherMembers.values()],
      ownerships: [...this.ownerships.values()],
      publishRequests: [...this.publishRequests.values()],
    };
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private requirePublishRequest(id: string) {
    const request = this.publishRequests.get(id);
    if (!request) throw new StoreValidationError("Publish request not found.");
    return request;
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
