#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--self-test" ]; then
  phrase="$(openssl rand -hex 16)"
  sample="$(printf 'bslmesh-backup-self-test')"
  restored="$(printf '%s' "${sample}" | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:${phrase}" | openssl enc -d -aes-256-cbc -pbkdf2 -salt -pass "pass:${phrase}")"
  unset phrase
  if [ "${restored}" != "${sample}" ]; then
    echo "encrypted backup self-test failed" >&2
    exit 1
  fi
  echo "encrypted backup self-test passed"
  exit 0
fi

missing=()
for name in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_REGION BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_PASSPHRASE; do
  if [ -z "${!name:-}" ]; then
    missing+=("${name}")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "External backup storage is not configured. Refusing to upload." >&2
  echo "Required parameters, supplied on the server and not in chat or Git:" >&2
  printf '  %s\n' "${missing[@]}"
  echo "BACKUP_PASSPHRASE must stay off the VPS after the upload. The S3 secret must not be committed." >&2
  exit 2
fi

echo "External backup upload is not implemented until the storage parameters are present and reviewed." >&2
exit 2
