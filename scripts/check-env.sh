#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
printf '\n=== BSL Mesh developer environment (read-only) ===\n'
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  printf 'Distribution: %s\n' "${PRETTY_NAME:-unknown}"
  printf 'Base Ubuntu codename: %s\n' "${UBUNTU_CODENAME:-not set (LMDE/Debian?)}"
fi
check() {
  local name="$1"; shift
  if command -v "$1" >/dev/null 2>&1; then
    printf '%-18s %s\n' "$name" "$("$@" 2>&1 | head -n 1)"
  else
    printf '%-18s MISSING\n' "$name"
  fi
}
check 'git' git --version
check 'node' node --version
check 'npm' npm --version
check 'pnpm' pnpm --version
check 'docker client' docker --version
if command -v docker >/dev/null 2>&1; then
  printf '%-18s %s\n' 'docker compose' "$(docker compose version 2>&1 | head -n 1)"
  if docker info >/dev/null 2>&1; then
    printf 'docker daemon:    accessible to current user\n'
  else
    printf 'docker daemon:    not accessible to current user (possibly needs sudo/rootless setup)\n'
  fi
fi
check 'curl' curl --version
check 'unzip' unzip -v
printf 'Project AGENTS.md: %s\n' "$(test -f AGENTS.md && echo present || echo absent)"
printf 'Cursor rules:      %s\n' "$(find .cursor/rules -type f -name '*.mdc' 2>/dev/null | wc -l)"
printf 'Agent skills:      %s\n' "$(find .agents/skills -type f -name 'SKILL.md' 2>/dev/null | wc -l)"
printf 'No changes were made.\n'
