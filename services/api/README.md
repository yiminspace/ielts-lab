# IELTS API

The Node API serves archived study content, entity-based progress and private recordings. Application data lives in its own PostgreSQL database; archive files remain read-only and are not bundled in images. See [database migrations](migrations/README.md) for role provisioning and legacy progress import.

## Runtime

Service deployments require `IELTS_AUTH_REQUIRED=1`, `OWNER_USER_ID`, `AUTHKIT_API_URL`, `PUBLIC_ORIGIN`, `DATABASE_URL`, `RECORDINGS_ROOT` and a random `SESSION_SECRET` of at least 32 bytes. `AUTHKIT_API_URL` and `PUBLIC_ORIGIN` are HTTPS origins without paths. `ARCHIVE_ROOT` selects the read-only archive; without it the service uses original examples. The container listens with `HOST=0.0.0.0 PORT=4318`; the public proxy must preserve the original Host. `NODE_ENV=production` refuses startup without authentication. Bootstrap and migration credentials must not enter the runtime container.

Development without authentication is restricted to loopback hosts. It uses the existing local JSON progress file unless `DATABASE_URL` is explicitly supplied. Demo and archive progress are isolated in both storage modes.

## Authentication

- `GET /health`: public liveness response `{status,service,version}`; version is the injected `GIT_SHA`, or `dev`. Startup checks the database schema and role. Health does not perform a database query per request.
- `GET /api/config`: public `{authRequired,authkitApiUrl,publicOrigin}`; no owner identity or private configuration.
- `POST /api/auth/session`: same-origin request with an AuthKit `Authorization: Bearer …`. The API calls AuthKit's verify endpoint, requires full token scope and checks the verified UUID against the configured owner. It returns `{user:{id},expiresAt}` and establishes an opaque `__Host-ielts-session` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`). Tokens are never stored in that cookie.
- `GET /api/auth/me`: returns the cookie session's `{user:{id},expiresAt}`.
- `POST /api/auth/logout`: destroys the current API session and expires its cookie. The frontend separately ends its AuthKit app session.

Every API/content/media/recording request requires the owner cookie, except the explicit public endpoints and session exchange. Caller-supplied identity headers are ignored. Writes require the exact configured Origin; foreign Host and Origin requests are rejected. Cross-origin CORS access is not enabled.

API sessions live in memory, expire no later than the verified token and at most one hour, and are invalid after API restart. The frontend can exchange its still-valid AuthKit token again. AuthKit revocation is checked on exchange; an existing API session expires on logout, API restart or its deadline. This is intended for one API instance, not a shared session cluster.

## Progress protocol

`GET /api/progress` returns attempts, bookmarks, drafts, notes, settings and `sync:{protocol:'entities-v1',userId,revisions:{drafts,notes,bookmarks,settings}}`. Revisions are integer server versions, including deleted-record tombstones; an absent entity starts at version zero. Practice-session values remain available as complex JSON drafts.

`PUT /api/progress/:bucket/:encodedId` accepts `{value,expectedVersion}`. `DELETE` uses `{expectedVersion}` and preserves a tombstone. Responses contain `{version,updatedAt}`. A stale version returns 409 with `currentVersion` and never overwrites the newer value. Supported public buckets are drafts, notes, bookmarks, settings and practice_sessions; notes are strings and bookmark values are booleans.

`POST /api/attempts` accepts an attempt with a client-generated stable ID. Retrying the same value is idempotent; using that ID for different content returns 409. `POST /api/progress/import` accepts `{progress,merge:true}` and atomically adds only missing records, preserving existing values and tombstones. Repeating an import is safe. PostgreSQL mode rejects legacy whole-document `PUT /api/progress`; local JSON mode retains it for compatibility.

## Recordings

`POST /api/recordings?itemId=…&question=0&durationSeconds=…` accepts a raw audio body for a valid speaking item. It streams to a private file with a 32 MiB limit; supported media types are WebM, Ogg, MP4/M4A, MPEG and WAV. `question` is zero-based. A successful upload returns metadata including `id` and `audioUrl`, without a filesystem path. Failed uploads remove temporary files.

`GET /api/recordings?itemId=…` lists owned recordings in the current material mode. `GET`/`HEAD /api/recordings/:id/audio` supports Range/206/416 and returns private no-store content. `DELETE /api/recordings/:id` removes the owned metadata and file. There is no public recordings directory. UUID filenames, exclusive writes, descriptor-based reads and symlink checks restrict access to the configured recordings directory. Recordings need their own file backup alongside database metadata.

Tests use original synthetic content. Real PostgreSQL integration tests require an explicit `IELTS_TEST_ADMIN_DATABASE_URL`; without it they skip, and do not infer or connect to production.
