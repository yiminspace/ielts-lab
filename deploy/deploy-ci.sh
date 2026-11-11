#!/usr/bin/env bash
# Called only by the protected deployment job, never a build or pull-request job.
set -euo pipefail
umask 077
: "${RUNNER_TEMP:?}" "${SOPS_AGE_KEY:?}" "${DEPLOY_SSH_KEY:?}" "${DEPLOY_KNOWN_HOSTS:?}"
: "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${API_DIGEST:?}" "${WEB_DIGEST:?}" "${LEARNING_DIGEST:?}" "${RELEASE_SHA:?}"
[[ "$API_DIGEST" =~ ^sha256:[0-9a-f]{64}$ && "$WEB_DIGEST" =~ ^sha256:[0-9a-f]{64}$ && "$LEARNING_DIGEST" =~ ^sha256:[0-9a-f]{64}$ && "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 1
stage="$RUNNER_TEMP/ielts-release"
mkdir -m 700 "$stage"
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
printf '%s\n' "$DEPLOY_SSH_KEY" > "$stage/ssh.key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$stage/known_hosts"
# The protected job supplies both the ciphertext and its dedicated age key.
decrypt_config() {
  printf '%s' "${!1:?Missing protected configuration}" |
    "$RUNNER_TEMP/sops" --input-type dotenv --output-type dotenv --decrypt /dev/stdin > "$stage/$2"
}
decrypt_config IELTS_SOPS_API runtime.env
decrypt_config IELTS_SOPS_MIGRATION migration.env
decrypt_config IELTS_SOPS_API_LEARNING api-learning.env
decrypt_config IELTS_SOPS_LEARNING learning.env
unset IELTS_SOPS_API IELTS_SOPS_MIGRATION IELTS_SOPS_API_LEARNING IELTS_SOPS_LEARNING SOPS_AGE_KEY
# Do not print decrypted values. Decryption output is not automatically masked by Actions.
python3 deploy/validate-env.py "$stage/runtime.env" "$stage/migration.env" "$stage/api-learning.env" "$stage/learning.env"
tar -C "$stage" -cf - runtime.env migration.env api-learning.env learning.env |
  ssh -T -i "$stage/ssh.key" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$stage/known_hosts" \
    "$DEPLOY_USER@$DEPLOY_HOST" "ielts-release $API_DIGEST $WEB_DIGEST $LEARNING_DIGEST $RELEASE_SHA"
