import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = 2;
const entityBuckets = new Set([
  "drafts",
  "notes",
  "bookmarks",
  "settings",
  "practice_sessions",
]);
const userTables = [
  ...entityBuckets,
  "attempts",
  "recordings",
  "daily_lessons",
];
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const iso = (value) =>
  value instanceof Date ? value.toISOString() : String(value);
const failure = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function cleanValue(value, depth = 0) {
  if (depth > 40) return false;
  if (Array.isArray(value)) return value.every((v) => cleanValue(v, depth + 1));
  if (object(value))
    return Object.entries(value).every(
      ([key, v]) =>
        !["__proto__", "constructor", "prototype"].includes(key) &&
        cleanValue(v, depth + 1),
    );
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
function assertScope(userId, mode) {
  if (!uuid.test(userId || "")) throw failure(400, "用户身份无效");
  if (!["archive", "demo"].includes(mode)) throw failure(400, "材料模式无效");
}
function tableFor(bucket, id) {
  if (!entityBuckets.has(bucket)) throw failure(400, "记录类别无效");
  return bucket === "drafts" && /^(?:paper|exam):/.test(id)
    ? "practice_sessions"
    : bucket;
}
function assertEntity(bucket, id, value, expectedVersion, deleted) {
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 500 ||
    /[\x00-\x1f]/.test(id) ||
    ["__proto__", "constructor", "prototype"].includes(id)
  )
    throw failure(400, "记录 ID 无效");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0)
    throw failure(400, "需要有效 expectedVersion");
  tableFor(bucket, id);
  if (
    !deleted &&
    (!cleanValue(value) ||
      Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
  )
    throw failure(400, "记录内容无效或过大");
  if (
    !deleted &&
    bucket === "notes" &&
    (typeof value !== "string" || value.length > 200000)
  )
    throw failure(400, "笔记内容无效");
  if (!deleted && bucket === "bookmarks" && typeof value !== "boolean")
    throw failure(400, "收藏状态无效");
}
export function validAttempt(value) {
  const kinds = [
    "listening",
    "reading",
    "writing",
    "speaking",
    "vocabulary",
    "sentences",
    "grammar",
    "numbers",
    "typing",
    "courses",
  ];
  return (
    object(value) &&
    cleanValue(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 200 &&
    typeof value.itemId === "string" &&
    value.itemId.length > 0 &&
    value.itemId.length <= 200 &&
    typeof value.title === "string" &&
    value.title.length <= 1000 &&
    kinds.includes(value.kind) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    ["score", "total", "durationSeconds"].every(
      (key) =>
        value[key] === undefined ||
        (Number.isFinite(value[key]) && value[key] >= 0),
    ) &&
    (value.detail === undefined ||
      (typeof value.detail === "string" && value.detail.length <= 200000)) &&
    (value.answers === undefined ||
      (object(value.answers) &&
        Object.values(value.answers).every(
          (answer) =>
            (typeof answer === "string" && answer.length <= 100000) ||
            (Array.isArray(answer) &&
              answer.every((v) => typeof v === "string" && v.length <= 100000)),
        ))) &&
    Buffer.byteLength(JSON.stringify(value)) <= 2 * 1024 * 1024
  );
}
function recordingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    itemId: row.item_id,
    question: row.question,
    durationSeconds: row.duration_seconds,
    contentType: row.content_type,
    size: Number(row.size),
    filename: row.filename,
    createdAt: iso(row.created_at),
  };
}

export class PostgresStore {
  constructor({ connectionString, ownerUserId, pool } = {}) {
    this.connectionString = connectionString;
    this.ownerUserId = ownerUserId;
    this.pool = pool;
    this.ownsPool = !pool;
  }
  async init() {
    if (!this.pool) {
      if (!this.connectionString) throw new Error("DATABASE_URL is required");
      const { Pool } = await import("pg");
      this.pool = new Pool({
        connectionString: this.connectionString,
        min: 0,
        max: 3,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
      });
      this.pool.on("error", () =>
        console.warn(
          "[database] idle connection failed; the next request will reconnect",
        ),
      );
    }
    try {
      const {
        rows: [role],
      } = await this.pool
        .query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
        EXISTS(SELECT 1 FROM pg_roles s WHERE s.rolname=session_user AND (s.rolsuper OR s.rolbypassrls OR s.rolcreatedb OR s.rolcreaterole OR s.rolreplication)) AS privileged_session,
        (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships,
        EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=r.oid) AS database_owner
        FROM pg_roles r WHERE rolname=current_user`);
      if (
        !role ||
        role.rolsuper ||
        role.rolbypassrls ||
        role.rolcreatedb ||
        role.rolcreaterole ||
        role.rolreplication ||
        role.privileged_session ||
        role.memberships ||
        role.database_owner
      )
        throw new Error(
          "DATABASE_URL must use a dedicated non-owner role without elevated privileges or role memberships",
        );
      const {
        rows: [historyAccess],
      } = await this.pool.query(
        "SELECT has_table_privilege(current_user, 'schema_migrations', 'INSERT,UPDATE,DELETE') AS writable",
      );
      if (historyAccess.writable)
        throw new Error(
          "Runtime role must not modify schema migration history",
        );
      const {
        rows: [schema],
      } = await this.pool.query(
        "SELECT max(version)::int AS version FROM schema_migrations WHERE rolled_back_at IS NULL",
      );
      if (schema?.version !== SCHEMA_VERSION)
        throw new Error(
          "Database schema is not current; run migrations with MIGRATION_DATABASE_URL",
        );
      const { rows: tables } = await this.pool.query(
        `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
        c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
        [userTables],
      );
      if (
        tables.length !== userTables.length ||
        tables.some(
          (t) => t.owns_table || !t.relrowsecurity || !t.relforcerowsecurity,
        )
      )
        throw new Error(
          "Database tenant tables must have forced RLS and a separate migration owner",
        );
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.resolve().then(() => {
      if (this.ownsPool && this.pool) return this.pool.end();
    });
    return this.closePromise;
  }
  async transaction(userId, mode, callback, repeatable = false) {
    assertScope(userId, mode);
    const client = await this.pool.connect();
    try {
      await client.query(
        repeatable ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN",
      );
      await client.query("SELECT set_config('app.user_id', $1, true)", [
        userId,
      ]);
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async getProgress(userId, mode) {
    return this.transaction(
      userId,
      mode,
      async (client) => {
        const result = {
          attempts: [],
          bookmarks: [],
          drafts: {},
          notes: {},
          settings: {},
          sync: {
            protocol: "entities-v1",
            revisions: { drafts: {}, notes: {}, bookmarks: {}, settings: {} },
            userId,
          },
          userId,
        };
        let latest = 0;
        for (const table of entityBuckets) {
          const bucket = table === "practice_sessions" ? "drafts" : table;
          const { rows } = await client.query(
            `SELECT id,value,version,deleted,updated_at FROM ${table} WHERE user_id=$1 AND mode=$2 ORDER BY id`,
            [userId, mode],
          );
          for (const row of rows) {
            result.sync.revisions[bucket][row.id] = row.version;
            latest = Math.max(latest, new Date(row.updated_at).getTime());
            if (!row.deleted) {
              if (bucket === "bookmarks") {
                if (row.value === true) result.bookmarks.push(row.id);
              } else result[bucket][row.id] = row.value;
            }
          }
        }
        const { rows } = await client.query(
          "SELECT data,updated_at FROM attempts WHERE user_id=$1 AND mode=$2 ORDER BY created_at DESC,id",
          [userId, mode],
        );
        result.attempts = rows.map((row) => row.data);
        for (const row of rows)
          latest = Math.max(latest, new Date(row.updated_at).getTime());
        if (latest) result.updatedAt = new Date(latest).toISOString();
        return result;
      },
      true,
    );
  }
  async setEntity(
    userId,
    mode,
    bucket,
    id,
    { value, expectedVersion },
    deleted = false,
  ) {
    assertEntity(bucket, id, value, expectedVersion, deleted);
    const table = tableFor(bucket, id);
    return this.transaction(userId, mode, async (client) => {
      let rows;
      if (expectedVersion === 0) {
        ({ rows } = await client.query(
          `INSERT INTO ${table}(user_id,mode,id,value,version,deleted)
          VALUES($1,$2,$3,$4::jsonb,1,$5) ON CONFLICT DO NOTHING RETURNING version,updated_at`,
          [userId, mode, id, JSON.stringify(deleted ? null : value), deleted],
        ));
      } else {
        ({ rows } = await client.query(
          `UPDATE ${table} SET value=$4::jsonb,version=version+1,deleted=$5,updated_at=clock_timestamp()
          WHERE user_id=$1 AND mode=$2 AND id=$3 AND version=$6 RETURNING version,updated_at`,
          [
            userId,
            mode,
            id,
            JSON.stringify(deleted ? null : value),
            deleted,
            expectedVersion,
          ],
        ));
      }
      if (!rows.length) {
        const {
          rows: [existing],
        } = await client.query(
          `SELECT version FROM ${table} WHERE user_id=$1 AND mode=$2 AND id=$3`,
          [userId, mode, id],
        );
        throw failure(409, "记录已在其他设备更新，请刷新后重试", {
          currentVersion: existing?.version ?? 0,
        });
      }
      return { version: rows[0].version, updatedAt: iso(rows[0].updated_at) };
    });
  }
  async insertAttempt(client, userId, mode, attempt) {
    if (!validAttempt(attempt)) throw failure(400, "练习记录无效");
    const { rows } = await client.query(
      `INSERT INTO attempts(user_id,mode,id,data,created_at) VALUES($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT DO NOTHING RETURNING data,updated_at`,
      [userId, mode, attempt.id, JSON.stringify(attempt), attempt.createdAt],
    );
    if (rows.length)
      return {
        attempt: rows[0].data,
        created: true,
        updatedAt: iso(rows[0].updated_at),
      };
    const {
      rows: [existing],
    } = await client.query(
      "SELECT data,data=$4::jsonb AS equal,updated_at FROM attempts WHERE user_id=$1 AND mode=$2 AND id=$3",
      [userId, mode, attempt.id, JSON.stringify(attempt)],
    );
    if (!existing?.equal)
      throw failure(409, "相同作答 ID 已存在，未覆盖原记录");
    return {
      attempt: existing.data,
      created: false,
      updatedAt: iso(existing.updated_at),
    };
  }
  async addAttempt(userId, mode, attempt, lessonSeed) {
    return this.transaction(userId, mode, async (client) => {
      const result = await this.insertAttempt(client, userId, mode, attempt);
      if (lessonSeed) await this.insertDaily(client, userId, mode, lessonSeed);
      return result;
    });
  }
  async insertDaily(client, userId, mode, seed) {
    if (
      !cleanValue(seed) ||
      Buffer.byteLength(JSON.stringify(seed)) > 2 * 1024 * 1024
    )
      throw failure(400, "课程内容无效或过大");
    const { rows } = await client.query(
      `INSERT INTO daily_lessons(user_id,mode,id,attempt_id,version,data,created_at)
       VALUES($1,$2,$3,$4,1,$5::jsonb,$6) ON CONFLICT DO NOTHING RETURNING data`,
      [
        userId,
        mode,
        seed.id,
        seed.attemptId,
        JSON.stringify(seed),
        seed.createdAt,
      ],
    );
    if (rows.length) return rows[0].data;
    const { rows: existing } = await client.query(
      "SELECT data FROM daily_lessons WHERE user_id=$1 AND mode=$2 AND attempt_id=$3",
      [userId, mode, seed.attemptId],
    );
    return existing[0]?.data || null;
  }
  async ensureDaily(userId, mode, seed) {
    return this.transaction(userId, mode, (client) =>
      this.insertDaily(client, userId, mode, seed),
    );
  }
  async listDaily(userId, mode) {
    return this.transaction(userId, mode, async (client) => {
      const { rows } = await client.query(
        "SELECT data FROM daily_lessons WHERE user_id=$1 AND mode=$2 ORDER BY created_at DESC,id",
        [userId, mode],
      );
      return rows.map((row) => row.data);
    });
  }
  async getDaily(userId, mode, id) {
    return this.transaction(userId, mode, async (client) => {
      const { rows } = await client.query(
        "SELECT data FROM daily_lessons WHERE user_id=$1 AND mode=$2 AND id=$3",
        [userId, mode, id],
      );
      return rows[0]?.data || null;
    });
  }
  async mutateDaily(userId, mode, id, change) {
    return this.transaction(userId, mode, async (client) => {
      const {
        rows: [existing],
      } = await client.query(
        "SELECT data,version FROM daily_lessons WHERE user_id=$1 AND mode=$2 AND id=$3 FOR UPDATE",
        [userId, mode, id],
      );
      if (!existing) throw failure(404, "课程不存在");
      const next = await change(structuredClone(existing.data));
      if (!next) return existing.data;
      next.version = existing.version + 1;
      next.updatedAt = new Date().toISOString();
      if (
        !cleanValue(next) ||
        Buffer.byteLength(JSON.stringify(next)) > 2 * 1024 * 1024
      )
        throw failure(413, "课程记录超过容量限制");
      await client.query(
        "UPDATE daily_lessons SET data=$4::jsonb,version=$5,updated_at=clock_timestamp() WHERE user_id=$1 AND mode=$2 AND id=$3",
        [userId, mode, id, JSON.stringify(next), next.version],
      );
      return next;
    });
  }
  async importProgress(userId, mode, progress) {
    if (
      !object(progress) ||
      !cleanValue(progress) ||
      !Array.isArray(progress.attempts) ||
      progress.attempts.length > 10000 ||
      !Array.isArray(progress.bookmarks) ||
      progress.bookmarks.length > 20000 ||
      !object(progress.drafts) ||
      !object(progress.notes) ||
      (progress.settings !== undefined && !object(progress.settings))
    )
      throw failure(400, "学习记录备份格式无效");
    return this.transaction(userId, mode, async (client) => {
      const imported = {
        attempts: 0,
        drafts: 0,
        notes: 0,
        bookmarks: 0,
        settings: 0,
      };
      // Import is additive: existing values and tombstones win, including attempts with matching IDs.
      for (const attempt of progress.attempts) {
        if (!validAttempt(attempt)) throw failure(400, "备份包含无效作答");
        const { rowCount } = await client.query(
          `INSERT INTO attempts(user_id,mode,id,data,created_at) VALUES($1,$2,$3,$4::jsonb,$5)
          ON CONFLICT DO NOTHING`,
          [
            userId,
            mode,
            attempt.id,
            JSON.stringify(attempt),
            attempt.createdAt,
          ],
        );
        imported.attempts += rowCount;
      }
      for (const bucket of ["drafts", "notes", "bookmarks", "settings"]) {
        const entries =
          bucket === "bookmarks"
            ? progress.bookmarks.map((id) => [id, true])
            : Object.entries(progress[bucket] || {});
        for (const [id, value] of entries) {
          assertEntity(bucket, id, value, 0, false);
          const table = tableFor(bucket, id);
          const { rowCount } = await client.query(
            `INSERT INTO ${table}(user_id,mode,id,value,version)
            VALUES($1,$2,$3,$4::jsonb,1) ON CONFLICT DO NOTHING`,
            [userId, mode, id, JSON.stringify(value)],
          );
          imported[bucket] += rowCount;
        }
      }
      return { ok: true, imported };
    });
  }
  async syncLibrary(mode, items, papers = []) {
    if (!["archive", "demo"].includes(mode))
      throw new Error("Invalid library mode");
    const client = await this.pool.connect();
    const pick = (value, keys) =>
      Object.fromEntries(
        keys.filter((key) => own(value, key)).map((key) => [key, value[key]]),
      );
    try {
      await client.query("BEGIN");
      for (const [table, values, keys] of [
        [
          "library_items",
          items,
          [
            "id",
            "title",
            "kind",
            "collection",
            "count",
            "description",
            "testTrack",
            "source",
          ],
        ],
        [
          "library_papers",
          papers,
          [
            "id",
            "title",
            "collection",
            "testTrack",
            "source",
            "listeningIds",
            "readingIds",
            "writingIds",
            "ready",
            "issues",
            "shortDemo",
            "listeningMarks",
            "readingMarks",
          ],
        ],
      ]) {
        for (const item of values)
          await client.query(
            `INSERT INTO ${table}(mode,id,metadata) VALUES($1,$2,$3::jsonb)
          ON CONFLICT(mode,id) DO UPDATE SET metadata=EXCLUDED.metadata,updated_at=now()`,
            [mode, item.id, JSON.stringify(pick(item, keys))],
          );
        await client.query(
          `DELETE FROM ${table} WHERE mode=$1 AND NOT (id=ANY($2::text[]))`,
          [mode, values.map((v) => v.id)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async listRecordings(userId, mode, itemId) {
    return this.transaction(userId, mode, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM recordings WHERE user_id=$1 AND mode=$2
        AND ($3::text IS NULL OR item_id=$3) ORDER BY created_at DESC,id`,
        [userId, mode, itemId || null],
      );
      return rows.map(recordingRow);
    });
  }
  async getRecording(userId, mode, id) {
    if (!uuid.test(id || "")) return null;
    return this.transaction(userId, mode, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        "SELECT * FROM recordings WHERE user_id=$1 AND mode=$2 AND id=$3",
        [userId, mode, id],
      );
      return recordingRow(row);
    });
  }
  async addRecording(metadata) {
    const {
      id = randomUUID(),
      userId,
      mode,
      itemId,
      question,
      durationSeconds,
      contentType,
      size,
      filename,
    } = metadata;
    assertScope(userId, mode);
    if (
      !uuid.test(id) ||
      typeof itemId !== "string" ||
      !itemId ||
      itemId.length > 200 ||
      !Number.isInteger(question) ||
      question < 0 ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds < 0 ||
      !Number.isInteger(size) ||
      size <= 0 ||
      size > 32 * 1024 * 1024 ||
      ![
        "audio/webm",
        "audio/ogg",
        "audio/mp4",
        "audio/wav",
        "audio/mpeg",
      ].includes(contentType) ||
      !new RegExp(`^${id}\\.(webm|ogg|mp4|m4a|wav|mp3)$`).test(filename)
    )
      throw failure(400, "录音信息无效");
    return this.transaction(userId, mode, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO recordings(user_id,mode,id,item_id,question,duration_seconds,content_type,size,filename)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          userId,
          mode,
          id,
          itemId,
          question,
          durationSeconds,
          contentType,
          size,
          filename,
        ],
      );
      return recordingRow(row);
    });
  }
  async deleteRecording(userId, mode, id) {
    if (!uuid.test(id || "")) return null;
    return this.transaction(userId, mode, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        "DELETE FROM recordings WHERE user_id=$1 AND mode=$2 AND id=$3 RETURNING *",
        [userId, mode, id],
      );
      return recordingRow(row);
    });
  }
}
