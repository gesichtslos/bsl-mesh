---
name: bootstrap-bslmesh-dev
description: "Diagnose and prepare a Linux Mint, Node.js 24, pnpm, Docker Compose and Cursor environment for BSL Mesh; use before initial scaffolding or when tooling fails."
---
# Bootstrap BSL Mesh developer environment

1. Read `AGENTS.md`, original `README.md`, `docs/02-ARCHITECTURE.md` and `docs/05-ROADMAP.md` wherever present; do not assume paths.
2. Run `bash scripts/check-env.sh`. Identify Linux Mint vs LMDE from `/etc/os-release` and inspect existing Node/pnpm/Docker before proposing installs.
3. Recommend Node 24 LTS (per project runtime), Corepack-managed pnpm with a pinned `packageManager`, and Docker Engine + Compose. Do not rewrite a working version manager, add privileged groups, alter APT repositories or run curl-piped scripts automatically.
4. Check `node --version`, `pnpm --version`, `docker compose version`, Docker daemon access, available disk and open dev ports **without uploading results**.
5. Use a minimal local Postgres Compose service bound to `127.0.0.1`; don't create a new production server here.
6. Show a list of detected tools, missing prerequisites, exact installation changes, risks, test commands and an undo path. Request permission for privileged changes.
7. Run a minimal smoke test only after dependencies are installed. Mark checks not run as **not tested**.

Trusted references: https://nodejs.org/en/about/previous-releases ; https://docs.docker.com/engine/install/ubuntu/ ; https://cursor.com/docs/skills
