# IELTS Lab deployment

The independent repository owns `ielts-web` and `ielts-api`, both published to
GHCR. The `yiminlab` platform owns AuthKit, PostgreSQL, the `web-proxy` Docker
network, TLS and Nginx. Public source and images contain no personal archive,
recordings, answers or runtime credentials.

## Services and public routes

| Service | Container port | Route |
|---|---|---|
| `ielts-web` | 4317 | `https://ielts.yiminlab.site/` |
| `ielts-api` | 4318 | `/api/*` and `/media/*` |
| API health | 4318 | `/health`, `{status,service,version}` |
| Web health | 4317 | `/web-health`, `{status,service,version}` |

`version` is the built Git commit SHA; a local unversioned build reports `dev`.
The API verifies AuthKit identities, restricts them to `OWNER_USER_ID`, then
issues its own secure HttpOnly same-origin session cookie. Private API, archive
media and saved recordings all require that cookie. A front-end guard is not
the authorization boundary. Native audio/video Range requests use this cookie.

## One-time trusted setup

1. Publish the AuthKit SDK allowlist update, deploy the AuthKit exchange-target
   allowlist and Portal consumer, and install the IELTS Nginx virtual host.
   Configure DNS for `ielts.yiminlab.site`; the platform wildcard TLS certificate
   covers it. Validate the proxy before reloading.
2. Choose the owner account's verified AuthKit UUID. Create `ielts_db` with the
   API's `services/api/scripts/provision-db.mjs`, using separate administrator,
   `ielts_migrator` and `ielts_app` credentials. Administrator credentials are
   used only by this trusted bootstrap; never include them in the API container
   or encrypted deployment files. See `services/api/migrations/README.md`.
3. Install the reviewed `deploy/compose.yml` as the server deployment directory's
   `compose.yml`; install `deploy/server/release.py` root-owned as
   `/usr/local/sbin/ielts-release`, and `deploy/validate-env.py` plus
   `deploy/server/ssh-entry.py` root-owned under `/usr/local/lib/ielts-lab/`.
   The fixed release script uses `/srv/ielts-lab`; it is not a Git checkout.
4. Create root-owned `/srv/ielts-lab` with mode 700. Create `data/archive` and
   `data/recordings`, install the private archive without changing the source,
   and give container UID 1000 read access to archive directories/files and
   ownership of recordings. Recordings must be mode 700; archive is mounted
   read-only. The Compose bind mounts refuse to create missing source paths.
5. Create the dedicated `ielts-deploy` system user and SSH key. Do not add it to
   the `docker` group and do not grant an arbitrary root shell. Its authorized
   key must use `restrict,command="/usr/local/lib/ielts-lab/ssh-entry.py"`.
   A narrowly scoped sudo rule permits only `/usr/local/sbin/ielts-release`;
   that root-owned script independently validates argument count, image digests,
   fixed GHCR repositories and the bounded two-file configuration payload.
6. Generate a dedicated IELTS age identity on a trusted workstation. Keep a
   recovery copy in a password manager, commit only its public recipient in
   `.sops.yaml`, and create the two ciphertexts described in `secrets/README.md`.
   Do not reuse a platform-wide decryption identity.
7. Configure the GitHub `production` Environment to accept deployment only from
   protected `main`. Add Secrets `SOPS_AGE_KEY`, `DEPLOY_SSH_KEY` and
   `DEPLOY_KNOWN_HOSTS`, and Variables `DEPLOY_HOST`, `DEPLOY_USER`.
   `DEPLOY_KNOWN_HOSTS` must contain a previously verified host key. Do not turn
   off strict host-key checking or blindly trust a fresh network scan.
8. Choose GHCR package visibility independently from source visibility. Private
   packages require a server-side registry login with read access; the trusted
   administrator installs it in root's private Docker credentials, which Docker
   and Skopeo can read. Do not send registry credentials to the application or
   give them to the restricted SSH user. Public packages permit anonymous pulls
   but are optional. GHCR currently provides container image storage and bandwidth
   free for both public and private packages; see GitHub's
   [billing policy](https://docs.github.com/en/billing/concepts/product-billing/github-packages).

Bootstrap and root-owned script updates are trusted administrator actions;
normal releases do not replace the deployment scripts or Compose manifest.
The fixed release entry and platform IELTS backup share a maintenance lock; a
release attempted during a backup is rejected before changing containers and can
be retried once that bounded backup window ends.
The release SSH key cannot execute arbitrary repository scripts on the host.

## Configuration contract

`secrets/api.env.sops` encrypts the runtime fields from `.env.example`.
`secrets/migration.env.sops` encrypts only `DATABASE_URL` and
`MIGRATION_DATABASE_URL`. Both files use the same runtime URL; the database host
is `postgres`, database is `ielts_db`, and roles are `ielts_app` / `ielts_migrator`.
Only the one-time migration container receives the migration URL. A runtime
connection with superuser, database ownership, role memberships or BYPASSRLS is
rejected by the application.

SOPS protects configuration at rest/in Git. During deployment, the runner and
server necessarily handle usable plaintext. `deploy/deploy-ci.sh` uses private
temporary files, no shell tracing, strict known-host checking and cleanup on
exit. Never echo a decrypted configuration or upload it as an artifact; Actions
cannot be assumed to mask passwords found inside encrypted files.

## Release flow

`Release IELTS` runs only from `main`; its verification job runs tests, builds
and image isolation checks. It then publishes `sha-<commit>` tags and deploys
using exact `sha256` digests. The build jobs never receive production secrets.
The protected deployment job decrypts the two configuration files and streams a
bounded tar payload through SSH to the fixed release entry point.
SSH keepalives preserve that connection during a slow, bounded registry transfer.

The server resolves both requested GHCR digests before changing application
state. It first checks the config-derived cache tag, otherwise pulls the verified
single linux/amd64 child manifest. The requested CI index digest is retained in
the release record; provenance entries are not runtime images. If the daemon's network/proxy route fails,
it uses the preinstalled Skopeo binary in a userspace environment without inherited
proxy variables. That path verifies the exact OCI index/manifest hashes, selects
one linux/amd64 image, copies the pinned image through a private temporary Docker
archive and loads it. This does not build images or change/restart Docker/Clash.

All acquisition paths, including an administrator-preloaded image, verify the
remote digest chain and the image's raw config. The server streams `docker image
save` by its inspected immutable ID, reads only bounded metadata, follows the
archive manifest's config reference, checks its SHA-256 against the requested
registry manifest, and compares config `rootfs.diff_ids` with Docker inspection.
It verifies OCI source/revision labels, GIT_SHA and platform in both the raw
config and inspection. This supports classic Docker config IDs and newer
containerd-backed Docker manifest IDs without assuming either archive path layout.

Only then does the server run migrations, install mode-600 runtime configuration,
and start Compose without building or pulling. Runtime/migration/rollback commands
use the actual verified immutable engine image ID; `release.json` retains both
requested registry digests and actual image IDs, and `.env` stores the runtime
IDs for reboot recovery. Fixed `ielts-local` tags are derived from the remotely
verified config digest, identify loaded or preloaded images, and retain validated
images when other platform releases prune dangling images. An existing cache tag
is revalidated against the remote manifest, raw config and rootfs before reuse.
API/Web health must match the
same commit SHA. A successful release saves non-secret immutable
image pointers for host reboot recovery. Failed startup restores the previous
configuration/images when available; schema rollback is not automatic and
requires a reviewed, backward-compatible migration strategy.

Normal operations use CI/CD. Do not build images on the production server.
Configuration-only changes still need a release so the running container reads
the new values. App records are in PostgreSQL and files under `data/`; replacing
images does not replace either storage location. Backups and recovery are
separate from deployment; see [backup.md](backup.md).

## Acceptance boundary

Before calling deployment complete, verify anonymous access is rejected for
library/items/progress/media/recordings, a different valid account is rejected,
and the owner can save/reload a draft, replay Range media, upload/replay/delete a
recording, and recover persisted data after restart. Health checks alone do not
prove those behaviors. Check the public version SHA and actual browser login
callback after the platform allowlists have been deployed.
