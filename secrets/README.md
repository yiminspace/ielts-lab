# IELTS encrypted deployment configuration

Only IELTS-specific SOPS ciphertext belongs here. Create an independent age key;
keep its private identity in a password manager and the protected `production`
GitHub Environment Secret `SOPS_AGE_KEY`. Do not reuse the platform-wide key.

- `api.env.sops`: encrypted runtime configuration matching `.env.example`.
- `migration.env.sops`: encrypted deploy-only `DATABASE_URL` and
  `MIGRATION_DATABASE_URL`. The runtime URL must match `api.env.sops`.
- `learning.env.sops`: IELTS-only model gateway, speech models and internal
  runtime token. Uses an independent Bifrost virtual key, scoped to selected models.
- `api-learning.env.sops`: only the shared internal runtime token for the Node API.
  These optional learning files are used by the learning compose overlay; the
  existing two-image production release command does not decrypt or deploy them.

`.sops.yaml` at the repository root contains only this application's public age
recipient and creation rules. Never commit `.env`, an age identity or database
dumps. The build context excludes this directory, including all ciphertext.

Only the protected deployment job decrypts these files. It sends a bounded tar
payload to a fixed server release command; it never sends scripts for the server
to execute. Missing ciphertext intentionally blocks deployment. Provisioning
administrator credentials are used separately by a trusted administrator and
are never added to either file.
