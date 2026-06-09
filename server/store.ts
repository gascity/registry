import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import postgres, { type Sql } from "postgres";
import { randomToken, sha256 } from "./crypto";
import type {
  AccountReview,
  IdentityClaims,
  PublicUser,
  RegistryStore,
  ReviewInput,
  ReviewListResult,
  ReviewRow,
  SessionRecord,
  SessionUser,
} from "./types";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const idPrefix = {
  user: "usr",
  session: "ses",
  review: "rev",
  report: "rpt",
  audit: "aud",
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
        gascity_account_id text UNIQUE NOT NULL,
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
      SELECT * FROM users WHERE gascity_account_id = ${identity.subject} LIMIT 1
    `;
    const now = new Date();
    const handle = normalizeHandle(identity.handle ?? identity.email?.split("@")[0]) ?? "user";
    const displayName = identity.displayName?.trim() || handle;
    if (existing.length > 0) {
      const [updated] = await this.sql`
        UPDATE users
        SET email = ${identity.email ?? null},
            handle = COALESCE(NULLIF(handle, ''), ${handle}),
            display_name = COALESCE(NULLIF(display_name, ''), ${displayName}),
            avatar_url = ${identity.avatarUrl ?? null},
            updated_at = ${now}
        WHERE gascity_account_id = ${identity.subject}
        RETURNING *
      `;
      return sessionUser(updated as any);
    }
    const id = newId("user");
    const uniqueHandle = await this.resolveHandle(handle, id);
    const [created] = await this.sql`
      INSERT INTO users (
        id, gascity_account_id, email, handle, display_name, avatar_url, role, status, created_at, updated_at
      )
      VALUES (
        ${id}, ${identity.subject}, ${identity.email ?? null}, ${uniqueHandle}, ${displayName},
        ${identity.avatarUrl ?? null}, 'user', 'active', ${now}, ${now}
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
}

type FileState = {
  users: Array<SessionUser & { gascityAccountId: string }>;
  sessions: Array<{ hash: string; record: Omit<SessionRecord, "expiresAt"> & { expiresAt: string } }>;
  reviews: ReviewRow[];
  reports: string[];
  stars: string[];
};

class FileRegistryStore implements RegistryStore {
  readonly kind = "file" as const;
  private users = new Map<string, SessionUser & { gascityAccountId: string }>();
  private sessions = new Map<string, { record: SessionRecord; hash: string }>();
  private reviews = new Map<string, ReviewRow>();
  private reports = new Set<string>();
  private stars = new Set<string>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<FileState>;
      for (const user of raw.users ?? []) {
        this.users.set(user.id, { ...user, status: user.status === "disabled" ? "disabled" : "active" });
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
      for (const review of raw.reviews ?? []) this.reviews.set(review.id, review);
      this.reports = new Set(raw.reports ?? []);
      this.stars = new Set(raw.stars ?? []);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async close() {}

  async ensureUser(identity: IdentityClaims): Promise<SessionUser> {
    for (const user of this.users.values()) {
      if (user.gascityAccountId === identity.subject) return user;
    }
    const handle = normalizeHandle(identity.handle ?? identity.email?.split("@")[0]) ?? "local";
    const user: SessionUser & { gascityAccountId: string } = {
      id: newId("user"),
      gascityAccountId: identity.subject,
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
      reviews: [...this.reviews.values()],
      reports: [...this.reports],
      stars: [...this.stars],
    };
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
