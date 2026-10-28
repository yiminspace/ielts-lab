# IELTS Lab deployment

The independent repository owns `ielts-web` and `ielts-api`, both published to
GHCR. The `yiminlab` platform owns AuthKit, PostgreSQL, the `web-proxy` Docker
network, TLS and Nginx. Public source and images contain no personal archive,
recordings, answers or runtime credentials.

## Services and public routes

| Service     | Container port | Route                                     |
| ----------- | -------------- | ----------------------------------------- |
| `ielts-web` | 4317           | `https://ielts.yiminlab.site/`            |
| `ielts-api` | 4318           | `/api/*` and `/media/*`                   |
| API health  | 4318           | `/health`, `{status,service,version}`     |
| Web health  | 4317           | `/web-health`, `{status,service,version}` |

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
   fixed GHCR repositories and the bounded two-file legacy / four-file learning configuration payload.
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

`Release IELTS` builds only from `main`; its verification job runs tests, production builds
and image isolation checks. Private runtime source is built inside the private
`yiminspace/agent-runtime` repository using its own `GITHUB_TOKEN`. Its
`consumer-image.yml` workflow accepts a full IELTS commit SHA already reachable
from public `main`, validates the runtime pin and lock, runs offline Python tests,
and publishes `ghcr.io/yiminspace/ielts-learning:sha-<consumer commit>`.
The only uploaded artifact is `learning-image.json`, containing fixed revisions
and an immutable image digest; it contains no private source or credentials.

A trusted maintainer then dispatches `release.yml` on IELTS `main`, passing
`learning_digest` from that receipt. The build jobs publish same-commit API/Web
images without production configuration. The protected production job decrypts
`api.env.sops`, `migration.env.sops`, `api-learning.env.sops`, and `learning.env.sops`,
validates isolated Node/learning credentials and fixed service destinations, then
streams exactly four bounded regular env files to the fixed release command.
Pushes to `main` verify/build but do not deploy before the private image is ready.
SSH keepalives preserve that connection during bounded registry transfers.

The current trusted command is `ielts-release API_DIGEST WEB_DIGEST LEARNING_DIGEST SHA`.
The old two-image / three-argument protocol is retained only for legacy deployments.
An administrator installs the reviewed root-owned release entry, validator, base
Compose and learning overlay before the first three-image release; CI cannot replace
these trusted host files. `data/daily` belongs to UID 1000 and `data/runtime` to
UID 10001, both mode 0700, with existing archive and recordings retained.

The server resolves all requested GHCR digests before changing application
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
API/Web/learning authenticated health must match the
same commit SHA. The learning liveness endpoint remains public inside the container;
version and capability endpoints require the internal service token. A successful release saves non-secret immutable
image pointers for host reboot recovery. Failed startup restores the previous
configuration/images when available; schema rollback is not automatic and
requires a reviewed compatibility strategy. The first 001→002 upgrade is additive,
but the old schema-1 API refuses schema-2 on startup; preserve the pre-upgrade backup
and use a verified schema-2-compatible application for recovery rather than dropping new data.

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

## Production activation: 2026-10-28

The three-service release at `5144fb5d31f498c26e933b7001ffd1970bb21ed6` is active; [release run](https://github.com/yiminspace/ielts-lab/actions/runs/40656076704) completed successfully. A schema-1/2-compatible legacy pair at `86711e770273835429656b56aa20ec437cf99cdf` was deployed first, so the automatic rollback candidate can start after migration 002 without removing Daily tables. The pre-upgrade full backup was restored into an isolated database/file tree.

The host GHCR blob route was slow. Images built on the trusted workstation/CI were transferred as private archives, then the unchanged server release endpoint verified remote immutable manifests, raw config digests, rootfs, Linux/amd64 and matching revisions before execution. No server build occurred. Trusted CI alone decrypted and supplied the production configuration.

The platform backup chain was upgraded via [yiminlab PR 542](https://github.com/yiminspace/yiminlab/pull/542). Installed Mac consumers still verified the existing v3 snapshot before the server producer was replaced. The first v4 snapshot is `20261028_083246`; it includes Daily audio, a standalone runtime SQLite snapshot and the three-service configuration. Full verification outcomes are recorded in [coverage](coverage.md#生产部署与实际镜像验收).
