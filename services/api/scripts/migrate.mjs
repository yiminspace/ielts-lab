import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
export async function migrate({
  connectionString,
  direction = "up",
  allowSuperuser = false,
  runtimeRole,
} = {}) {
  if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is required");
  if (!["up", "down"].includes(direction))
    throw new Error("Expected migration direction up or down");
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const {
      rows: [role],
    } = await client.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    if (!allowSuperuser && (role.rolsuper || role.rolbypassrls))
      throw new Error(
        "Use a dedicated migration role without SUPERUSER or BYPASSRLS",
      );
    await client.query("SELECT pg_advisory_lock(734129186)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),rolled_back_at timestamptz)`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migration_events (
      id bigserial PRIMARY KEY,version integer NOT NULL,direction text NOT NULL CHECK(direction IN ('up','down')),
      checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await fs.readdir(directory))
      .filter((name) => /^\d+_.+\.up\.sql$/.test(name))
      .sort();
    const { rows: applied } = await client.query(
      "SELECT * FROM schema_migrations WHERE rolled_back_at IS NULL ORDER BY version",
    );
    const pending =
      direction === "up"
        ? files
        : files.filter(
            (name) => Number(name.split("_")[0]) === applied.at(-1)?.version,
          );
    let count = 0;
    for (const filename of pending) {
      const version = Number(filename.split("_")[0]);
      const up = await fs.readFile(path.join(directory, filename), "utf8");
      const checksum = createHash("sha256").update(up).digest("hex");
      const existing = applied.find((row) => row.version === version);
      if (existing && existing.checksum !== checksum)
        throw new Error(`Migration ${version} checksum mismatch`);
      if (direction === "up" && existing) continue;
      const source =
        direction === "up"
          ? up
          : await fs.readFile(
              path.join(directory, filename.replace(".up.sql", ".down.sql")),
              "utf8",
            );
      await client.query("BEGIN");
      try {
        await client.query(source);
        if (direction === "up")
          await client.query(
            `INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)
          ON CONFLICT(version) DO UPDATE SET checksum=EXCLUDED.checksum,name=EXCLUDED.name,applied_at=now(),rolled_back_at=NULL`,
            [version, filename, checksum],
          );
        else
          await client.query(
            "UPDATE schema_migrations SET rolled_back_at=now() WHERE version=$1",
            [version],
          );
        await client.query(
          "INSERT INTO schema_migration_events(version,direction,checksum) VALUES($1,$2,$3)",
          [version, direction, checksum],
        );
        await client.query("COMMIT");
        count++;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    if (runtimeRole) {
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole))
        throw new Error("Invalid runtime role name");
      const quoted = `"${runtimeRole}"`;
      await client.query(
        `REVOKE ALL ON schema_migrations,schema_migration_events FROM ${quoted}`,
      );
      await client.query(`GRANT SELECT ON schema_migrations TO ${quoted}`);
      for (const name of [
        "drafts",
        "notes",
        "bookmarks",
        "settings",
        "practice_sessions",
        "attempts",
        "recordings",
        "daily_lessons",
        "library_items",
        "library_papers",
      ]) {
        const {
          rows: [found],
        } = await client.query("SELECT to_regclass($1) AS relation", [name]);
        if (found.relation)
          await client.query(
            `GRANT SELECT,INSERT,UPDATE,DELETE ON "${name}" TO ${quoted}`,
          );
      }
    }
    return { direction, count };
  } finally {
    await client.query("SELECT pg_advisory_unlock(734129186)").catch(() => {});
    await client.end();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const connectionString = process.env.MIGRATION_DATABASE_URL;
    if (connectionString && connectionString === process.env.DATABASE_URL)
      throw new Error("Migration and runtime credentials must be separate");
    const runtimeRole = process.env.DATABASE_URL
      ? decodeURIComponent(new URL(process.env.DATABASE_URL).username)
      : undefined;
    const result = await migrate({
      connectionString,
      direction: process.argv[2] || "up",
      runtimeRole,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    // Do not print connection strings or underlying driver messages containing credentials.
    console.error(
      "Database migration failed. Check migration role, connectivity, schema and SQL files.",
    );
    process.exitCode = 1;
  }
}
