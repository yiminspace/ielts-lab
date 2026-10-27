import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresStore } from "../services/api/postgres.mjs";
import { migrate } from "../services/api/scripts/migrate.mjs";
import { provisionDatabase } from "../services/api/scripts/provision-db.mjs";

const adminURL = process.env.IELTS_TEST_ADMIN_DATABASE_URL;
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const attempt = (id = randomUUID()) => ({
  id,
  itemId: "demo-reading",
  title: "Original reading",
  kind: "reading",
  createdAt: new Date().toISOString(),
  answers: { 1: "example" },
  score: 1,
  total: 1,
});

test(
  "PostgreSQL store: real restricted roles, CAS, isolation, idempotency, import, metadata and rollback",
  { skip: !adminURL },
  async (t) => {
    const { Client } = await import("pg");
    const suffix = `${process.pid}_${Date.now()}`;
    const db = `ielts_store_test_${suffix}`;
    const runtimeRole = `ielts_app_test_${suffix}`;
    const migrationRole = `ielts_migrate_test_${suffix}`;
    const makeURL = (name, database = db) => {
      const url = new URL(adminURL);
      url.username = name;
      url.password = "local-original-test-only";
      url.pathname = `/${database}`;
      return url.toString();
    };
    const runtimeURL = makeURL(runtimeRole);
    const migrationURL = makeURL(migrationRole);
    const admin = new Client({ connectionString: adminURL });
    await admin.connect();
    const stores = [];
    t.after(async () => {
      for (const store of stores) await store.close();
      await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      for (const role of [runtimeRole, migrationRole])
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    });
    await provisionDatabase({ adminURL, migrationURL, runtimeURL });
    assert.deepEqual(
      await migrate({ connectionString: migrationURL, runtimeRole }),
      { direction: "up", count: 1 },
    );
    assert.deepEqual(
      await migrate({ connectionString: migrationURL, runtimeRole }),
      { direction: "up", count: 0 },
    );
    const store = new PostgresStore({ connectionString: runtimeURL });
    stores.push(store);
    await store.init();
    const second = new PostgresStore({ connectionString: runtimeURL });
    stores.push(second);
    await second.init();

    await t.test(
      "runtime cannot change schema or read another request's tenant",
      async () => {
        await assert.rejects(
          store.pool.query("UPDATE schema_migrations SET name='tampered'"),
          /permission denied/i,
        );
        await assert.rejects(
          store.pool.query("CREATE TABLE forbidden(id int)"),
          /permission denied/i,
        );
        await assert.rejects(
          new PostgresStore({ connectionString: adminURL }).init(),
          /dedicated non-owner role/,
        );
        const raw = await store.pool.query("SELECT * FROM drafts");
        assert.equal(raw.rowCount, 0);
      },
    );
    await t.test(
      "simultaneous CAS writers have one winner; tombstones prevent stale resurrection",
      async () => {
        const first = await store.setEntity(
          owner,
          "demo",
          "drafts",
          "exam:demo-reading",
          { value: { answer: "one" }, expectedVersion: 0 },
        );
        assert.equal(first.version, 1);
        const writes = await Promise.allSettled([
          store.setEntity(owner, "demo", "drafts", "exam:demo-reading", {
            value: { answer: "two" },
            expectedVersion: 1,
          }),
          second.setEntity(owner, "demo", "drafts", "exam:demo-reading", {
            value: { answer: "three" },
            expectedVersion: 1,
          }),
        ]);
        assert.equal(writes.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(
          writes.find((r) => r.status === "rejected").reason.status,
          409,
        );
        const deleted = await store.setEntity(
          owner,
          "demo",
          "drafts",
          "exam:demo-reading",
          { expectedVersion: 2 },
          true,
        );
        assert.equal(deleted.version, 3);
        await assert.rejects(
          second.setEntity(owner, "demo", "drafts", "exam:demo-reading", {
            value: {},
            expectedVersion: 0,
          }),
          { status: 409, currentVersion: 3 },
        );
        const progress = await store.getProgress(owner, "demo");
        assert.equal(progress.drafts["exam:demo-reading"], undefined);
        assert.equal(progress.sync.revisions.drafts["exam:demo-reading"], 3);
        const {
          rows: [sessionCount],
        } = await store.transaction(owner, "demo", (client) =>
          client.query("SELECT count(*)::int AS n FROM practice_sessions"),
        );
        assert.equal(sessionCount.n, 1);
      },
    );
    await t.test(
      "mode and user identities isolate all entity types",
      async () => {
        await store.setEntity(owner, "archive", "notes", "demo-reading", {
          value: "owner archive",
          expectedVersion: 0,
        });
        await store.setEntity(other, "archive", "notes", "demo-reading", {
          value: "other archive",
          expectedVersion: 0,
        });
        await store.setEntity(owner, "demo", "notes", "demo-reading", {
          value: "owner demo",
          expectedVersion: 0,
        });
        await store.setEntity(owner, "demo", "bookmarks", "demo-reading", {
          value: true,
          expectedVersion: 0,
        });
        await store.setEntity(owner, "demo", "settings", "track", {
          value: "general",
          expectedVersion: 0,
        });
        assert.equal(
          (await store.getProgress(owner, "archive")).notes["demo-reading"],
          "owner archive",
        );
        assert.equal(
          (await store.getProgress(other, "archive")).notes["demo-reading"],
          "other archive",
        );
        const progress = await second.getProgress(owner, "demo");
        assert.equal(progress.notes["demo-reading"], "owner demo");
        assert.deepEqual(progress.bookmarks, ["demo-reading"]);
        assert.equal(progress.settings.track, "general");
        assert.equal(progress.sync.userId, owner);
        await store
          .transaction(owner, "demo", async (client) => {
            assert.equal(
              (
                await client.query("SELECT * FROM notes WHERE user_id=$1", [
                  other,
                ])
              ).rowCount,
              0,
            );
            await assert.rejects(
              client.query(
                "INSERT INTO notes(user_id,mode,id,value,version) VALUES($1,'demo','spoof','null',1)",
                [other],
              ),
              /row-level security/i,
            );
          })
          .catch((error) => {
            if (!/current transaction is aborted/.test(error.message))
              throw error;
          });
      },
    );
    await t.test(
      "attempt retries are idempotent and mismatched duplicates cannot overwrite",
      async () => {
        const value = attempt();
        assert.equal(
          (await store.addAttempt(owner, "demo", value)).created,
          true,
        );
        assert.equal(
          (await second.addAttempt(owner, "demo", { ...value })).created,
          false,
        );
        await assert.rejects(
          store.addAttempt(owner, "demo", { ...value, score: 0 }),
          { status: 409 },
        );
        assert.equal(
          (await store.getProgress(owner, "demo")).attempts.length,
          1,
        );
        assert.equal(
          (await store.getProgress(other, "demo")).attempts.length,
          0,
        );
      },
    );
    await t.test(
      "legacy import is atomic, additive and repeatable, including preserved tombstones",
      async () => {
        const backup = {
          attempts: [attempt()],
          bookmarks: ["demo-reading", "new-bookmark"],
          drafts: {
            "exam:demo-reading": { stale: true },
            "new-draft": { text: "original" },
          },
          notes: { "demo-reading": "stale", "new-note": "new" },
          settings: { track: "academic" },
        };
        const imported = await store.importProgress(owner, "demo", backup);
        assert.equal(imported.imported.drafts, 1);
        assert.equal(imported.imported.notes, 1);
        assert.equal(imported.imported.bookmarks, 1);
        assert.equal(imported.imported.attempts, 1);
        const repeat = await second.importProgress(owner, "demo", backup);
        assert.equal(
          Object.values(repeat.imported).reduce((a, b) => a + b, 0),
          0,
        );
        const progress = await store.getProgress(owner, "demo");
        assert.equal(progress.drafts["exam:demo-reading"], undefined);
        assert.equal(progress.notes["demo-reading"], "owner demo");
        assert.equal(progress.settings.track, "general");
        await assert.rejects(
          store.importProgress(owner, "demo", {
            attempts: [attempt()],
            bookmarks: [],
            drafts: { atomic: {} },
            notes: { invalid: 3 },
          }),
          { status: 400 },
        );
        assert.equal(
          (await store.getProgress(owner, "demo")).drafts.atomic,
          undefined,
        );
        assert.equal(
          (await store.getProgress(owner, "demo")).attempts.length,
          progress.attempts.length,
        );
      },
    );
    await t.test(
      "recording metadata is scoped and library metadata excludes filesystem details",
      async () => {
        const id = randomUUID();
        const meta = await store.addRecording({
          id,
          userId: owner,
          mode: "demo",
          itemId: "demo-speaking",
          question: 1,
          durationSeconds: 1.5,
          contentType: "audio/webm",
          size: 15,
          filename: `${id}.webm`,
        });
        assert.equal(meta.itemId, "demo-speaking");
        assert.equal(await store.getRecording(other, "demo", id), null);
        assert.equal(await store.getRecording(owner, "archive", id), null);
        assert.equal(
          (await store.listRecordings(owner, "demo", "demo-speaking")).length,
          1,
        );
        assert.equal((await store.deleteRecording(owner, "demo", id)).id, id);
        assert.equal(await store.getRecording(owner, "demo", id), null);
        await store.syncLibrary("demo", [
          {
            id: "demo-reading",
            title: "Original",
            kind: "reading",
            file: "must not persist",
          },
        ]);
        const {
          rows: [row],
        } = await store.pool.query(
          "SELECT metadata FROM library_items WHERE mode='demo'",
        );
        assert.equal(row.metadata.file, undefined);
      },
    );
    await t.test(
      "schema rollback is recorded and prevents runtime startup until reapplied",
      async () => {
        assert.equal(
          (
            await migrate({
              connectionString: migrationURL,
              direction: "down",
              runtimeRole,
            })
          ).count,
          1,
        );
        const invalid = new PostgresStore({ connectionString: runtimeURL });
        await assert.rejects(invalid.init(), /schema is not current/);
        const migration = new Client({ connectionString: migrationURL });
        await migration.connect();
        assert.equal(
          (
            await migration.query(
              "SELECT direction FROM schema_migration_events ORDER BY id DESC LIMIT 1",
            )
          ).rows[0].direction,
          "down",
        );
        await migration.end();
        assert.equal(
          (await migrate({ connectionString: migrationURL, runtimeRole }))
            .count,
          1,
        );
        const restored = new PostgresStore({ connectionString: runtimeURL });
        stores.push(restored);
        await restored.init();
      },
    );
  },
);
