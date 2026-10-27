# IELTS database migrations

The API never changes the schema at startup. It checks the schema version and requires a separate, non-owner runtime role with no elevated privileges. User-owned tables force row-level security using transaction-local `app.user_id`; application queries also include the verified user UUID and archive/demo mode.

Use three distinct roles:

- A bootstrap administrator can create the IELTS database and its two roles. Its URL is passed only to the provisioning CLI as `PROVISION_DATABASE_URL`.
- `MIGRATION_DATABASE_URL` belongs to the migration role, which owns only this application's database and objects. It has no superuser, bypass-RLS, role creation or database creation privileges after bootstrap.
- `DATABASE_URL` belongs to the API runtime role, which has CRUD on application tables and read-only access to the schema version. It cannot create schema objects or change migration history.

Configure these values through a trusted private environment. Never commit URLs containing passwords or put them in command-line arguments, logs or images. Then run:

```sh
node services/api/scripts/provision-db.mjs
node services/api/scripts/migrate.mjs up
```

Provisioning is idempotent but refuses to take ownership of an existing database owned by another role. Review and perform any ownership migration separately. The administrator credential must not be present in the application runtime. Supply both migration and runtime URLs to migration execution so it can establish the intended grants.

Each applied SQL migration's checksum is recorded. `schema_migration_events` records successful up/down actions, and rollback timestamps remain in `schema_migrations`. Applied migration files must not be edited.

```sh
node services/api/scripts/migrate.mjs down
```

`down` rolls back the latest migration. The initial migration's rollback **deletes all application tables and their data** while preserving the migration audit trail. Back up data and review the SQL before running it; this is not a data restore command. The API refuses to start after rollback until a compatible schema is applied.

Import an existing IELTS progress backup with an explicit mode:

```sh
node services/api/scripts/import-progress.mjs /absolute/path/to/progress.json archive
```

The CLI uses `OWNER_USER_ID` and the runtime `DATABASE_URL`. It only adds missing records, is atomic, and preserves existing records and deletion tombstones. Repeating the same import is safe. It does not import media or overwrite current server drafts.

The real PostgreSQL integration test creates and destroys a dedicated test database and two dedicated roles on the instance explicitly supplied in `IELTS_TEST_ADMIN_DATABASE_URL`. Without that variable, it skips; no production connection is inferred.
