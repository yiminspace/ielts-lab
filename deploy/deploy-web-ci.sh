#!/usr/bin/env bash
# Web-only deployment sends no application configuration and needs no SOPS key.
set -euo pipefail
umask 077
: "${RUNNER_TEMP:?}" "${DEPLOY_SSH_KEY:?}" "${DEPLOY_KNOWN_HOSTS:?}"
: "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${WEB_DIGEST:?}" "${RELEASE_SHA:?}" "${API_BASE_SHA:?}"
[[ "$WEB_DIGEST" =~ ^sha256:[0-9a-f]{64}$ && "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ && "$API_BASE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 1
stage="$(mktemp -d "$RUNNER_TEMP/ielts-web-release.XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
printf '%s\n' "$DEPLOY_SSH_KEY" > "$stage/ssh.key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$stage/known_hosts"
ssh -T -i "$stage/ssh.key" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$stage/known_hosts" \
  "$DEPLOY_USER@$DEPLOY_HOST" "ielts-web-release $WEB_DIGEST $RELEASE_SHA $API_BASE_SHA" < /dev/null
