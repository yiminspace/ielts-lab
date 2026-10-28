import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { PostgresStore } from "../services/api/postgres.mjs";
import { provisionDatabase } from "../services/api/scripts/provision-db.mjs";
import { migrate } from "../services/api/scripts/migrate.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const adminURL = process.env.IELTS_TEST_ADMIN_DATABASE_URL;

test("rollback bridge accepts only schema 1 and additive schema 2 and retains role/RLS checks", async () => {
  const pool = (version, unsafe = false) => ({
    async query(sql, values) {
      if (sql.includes("FROM pg_roles r"))
        return { rows: [{ rolsuper: unsafe }] };
      if (sql.includes("has_table_privilege"))
        return { rows: [{ writable: false }] };
      if (sql.includes("max(version)")) return { rows: [{ version }] };
      if (sql.includes("FROM pg_class"))
        return {
          rows: values[0].map((relname) => ({
            relname,
            owns_table: false,
            relrowsecurity: true,
            relforcerowsecurity: true,
          })),
        };
      throw new Error("Unexpected compatibility query");
    },
  });
  for (const version of [1, 2])
    await new PostgresStore({ pool: pool(version) }).init();
  for (const version of [0, 3, null, undefined, "2", 2.1])
    await assert.rejects(
      new PostgresStore({ pool: pool(version) }).init(),
      /schema is not current/,
    );
  await assert.rejects(
    new PostgresStore({ pool: pool(2, true) }).init(),
    /dedicated non-owner role/,
  );
});

test(
  "legacy CRUD stays available after real additive Daily migration without changing Daily rows",
  { skip: !adminURL },
  async (t) => {
    const { Client } = await import("pg");
    const suffix = `bridge_${process.pid}_${Date.now()}`;
    const database = `ielts_${suffix}`,
      runtimeRole = `ielts_app_${suffix}`,
      migrationRole = `ielts_migrate_${suffix}`;
    const makeURL = (role) => {
      const url = new URL(adminURL);
      url.username = role;
      url.password = "original-bridge-test-only";
      url.pathname = `/${database}`;
      return url.toString();
    };
    const runtimeURL = makeURL(runtimeRole),
      migrationURL = makeURL(migrationRole);
    const admin = new Client({ connectionString: adminURL });
    await admin.connect();
    let store, migrator;
    t.after(async () => {
      await store?.close();
      await migrator?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      for (const role of [runtimeRole, migrationRole])
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    });
    await provisionDatabase({ adminURL, migrationURL, runtimeURL });
    await migrate({ connectionString: migrationURL, runtimeRole });
    store = new PostgresStore({ connectionString: runtimeURL });
    await store.init();
    const record = {
      id: randomUUID(),
      itemId: "demo-listening",
      title: "Original bridge attempt",
      kind: "listening",
      createdAt: new Date().toISOString(),
      answers: { "0:0": "Monday" },
      score: 1,
      total: 4,
    };
    await store.addAttempt(owner, "demo", record);
    await store.setEntity(owner, "demo", "notes", "demo-listening", {
      value: "Original preserved note",
      expectedVersion: 0,
    });
    await store.close();

    // The production migration is included unchanged as a fixture, not as a bridge migration.
    const sql = await fs.readFile(
      new URL("./fixtures/schema2-daily.up.sql", import.meta.url),
      "utf8",
    );
    migrator = new Client({ connectionString: migrationURL });
    await migrator.connect();
    await migrator.query("BEGIN");
    await migrator.query(sql);
    await migrator.query(
      "INSERT INTO schema_migrations(version,name,checksum) VALUES(2,'002_daily.up.sql',$1)",
      [createHash("sha256").update(sql).digest("hex")],
    );
    await migrator.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON daily_lessons TO "${runtimeRole}"`,
    );
    await migrator.query("COMMIT");
    store = new PostgresStore({ connectionString: runtimeURL });
    await store.init();
    const lessonId = `daily-${"a".repeat(40)}`;
    const lesson = {
      id: lessonId,
      attemptId: record.id,
      version: 1,
      status: "ready",
      original: "Original additive data is preserved",
    };
    await store.transaction(owner, "demo", (client) =>
      client.query(
        "INSERT INTO daily_lessons(user_id,mode,id,attempt_id,version,data) VALUES($1,'demo',$2,$3,1,$4::jsonb)",
        [owner, lessonId, record.id, JSON.stringify(lesson)],
      ),
    );
    const previous = await store.getProgress(owner, "demo");
    assert.deepEqual(previous.attempts, [record]);
    assert.equal(previous.notes["demo-listening"], "Original preserved note");
    assert.equal(
      (await store.addAttempt(owner, "demo", record)).created,
      false,
    );
    await store.setEntity(owner, "demo", "notes", "demo-listening", {
      value: "Original updated note",
      expectedVersion: 1,
    });
    await assert.rejects(
      store.setEntity(owner, "demo", "notes", "demo-listening", {
        value: "Stale note",
        expectedVersion: 1,
      }),
      { status: 409 },
    );
    assert.equal((await store.getProgress(other, "demo")).attempts.length, 0);
    const preserved = await store.transaction(owner, "demo", (client) =>
      client.query("SELECT data FROM daily_lessons WHERE id=$1", [lessonId]),
    );
    assert.deepEqual(preserved.rows[0].data, lesson);
    assert.equal(
      (await store.pool.query("SELECT * FROM daily_lessons")).rowCount,
      0,
    );
    await assert.rejects(
      store.pool.query("UPDATE schema_migrations SET name='forbidden'"),
      /permission denied/,
    );
  },
);
