import path from "node:path";
import { fileURLToPath } from "node:url";

const ident = (value) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value))
    throw new Error(
      "Database and role names must be lowercase SQL identifiers",
    );
  return `"${value}"`;
};
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
function parseDatabaseURL(value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Expected PostgreSQL URL");
  return {
    url,
    role: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
}

/** Admin bootstrap only. No administrator credential is used by the running API. */
export async function provisionDatabase({
  adminURL,
  migrationURL,
  runtimeURL,
} = {}) {
  if (!adminURL || !migrationURL || !runtimeURL)
    throw new Error("Provisioning requires admin, migration and runtime URLs");
  const runtime = parseDatabaseURL(runtimeURL);
  const migration = parseDatabaseURL(migrationURL);
  const admin = parseDatabaseURL(adminURL);
  if (
    runtime.database !== migration.database ||
    runtime.role === migration.role ||
    !runtime.password ||
    !migration.password ||
    runtime.role === admin.role ||
    migration.role === admin.role
  )
    throw new Error(
      "Use separate admin, migration and runtime roles for the same application database",
    );
  for (const name of [runtime.role, migration.role, runtime.database])
    ident(name);
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: adminURL,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    for (const config of [migration, runtime]) {
      const { rowCount } = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname=$1",
        [config.role],
      );
      await client.query(
        `${rowCount ? "ALTER" : "CREATE"} ROLE ${ident(config.role)} WITH LOGIN PASSWORD ${literal(config.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      const { rows: parents } = await client.query(
        `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
        JOIN pg_roles member ON member.oid=m.member WHERE member.rolname=$1`,
        [config.role],
      );
      for (const parent of parents)
        await client.query(
          `REVOKE ${ident(parent.rolname)} FROM ${ident(config.role)}`,
        );
    }
    const { rowCount } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname=$1",
      [runtime.database],
    );
    if (!rowCount)
      await client.query(
        `CREATE DATABASE ${ident(runtime.database)} OWNER ${ident(migration.role)}`,
      );
    else {
      const {
        rows: [existing],
      } = await client.query(
        "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
        [runtime.database],
      );
      if (existing.owner !== migration.role)
        throw new Error(
          "Existing database has a different owner; review ownership before provisioning",
        );
    }
    await client.query(
      `REVOKE ALL ON DATABASE ${ident(runtime.database)} FROM PUBLIC`,
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${ident(runtime.database)} TO ${ident(runtime.role)}`,
    );
  } finally {
    await client.end();
  }
  // Configure privileges as the migration owner, not as the API runtime role.
  const owner = new Client({
    connectionString: migrationURL,
    connectionTimeoutMillis: 5000,
  });
  await owner.connect();
  try {
    await owner.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${ident(runtime.role)}`);
    // Future migration-created tables receive CRUD, while schema history remains read-only below.
    await owner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${ident(runtime.role)}`,
    );
    const { rows: tables } = await owner.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    );
    for (const { tablename } of tables) {
      if (/^schema_migration/.test(tablename)) {
        await owner.query(
          `REVOKE ALL ON ${ident(tablename)} FROM ${ident(runtime.role)}`,
        );
        if (tablename === "schema_migrations")
          await owner.query(
            `GRANT SELECT ON ${ident(tablename)} TO ${ident(runtime.role)}`,
          );
      } else
        await owner.query(
          `GRANT SELECT,INSERT,UPDATE,DELETE ON ${ident(tablename)} TO ${ident(runtime.role)}`,
        );
    }
  } finally {
    await owner.end();
  }
  return {
    database: runtime.database,
    runtimeRole: runtime.role,
    migrationRole: migration.role,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await provisionDatabase({
      adminURL: process.env.PROVISION_DATABASE_URL,
      migrationURL: process.env.MIGRATION_DATABASE_URL,
      runtimeURL: process.env.DATABASE_URL,
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      "Database provisioning failed. Check separate credentials, role privileges and database ownership.",
    );
    process.exitCode = 1;
  }
}
