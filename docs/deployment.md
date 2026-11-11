# Deploy IELTS Lab

For a local setup, run `npm ci` and `npm run dev`. See the
[README](../README.md) for the application and the
[learning service guide](daily-runtime.md) for optional generated practice.

A hosted setup needs a web frontend, an API, PostgreSQL, and a trusted identity
provider. The API validates the signed-in owner for progress, materials and audio.
Use a restricted database role for the API and a separate role for migrations.
Keep imported materials and recordings in private storage.

Configure the API using [the environment template](../.env.example). When
enabling generated practice, keep the learning service on the private network
and store its model credentials and service token in protected deployment
configuration. Serve the app over HTTPS and keep production settings out of Git.

Before switching traffic, verify sign-in, anonymous access denial, and a
read-only smoke test. Create and verify a [backup](backup.md) before migrations.
