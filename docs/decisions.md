# Decisions

Big choices, newest last. The blueprint (`docs/blueprint.pdf`, v3) is the source of truth; this file records how we apply it.

## 2026-09-27: Project location and fresh start

- The project lives in `D:\Projects\devspace` (C: had only 15 GB free; Docker and IDE containers need space).
- This is a clean start from blueprint v3. Nothing is reused from the earlier `D:\DevSpace` attempt, which followed the old v2 design.

## 2026-09-27: Phase 0 added before Phase 1

Phase 0 sets up the machine and repo: Docker Desktop on WSL 2, GitHub CLI, a private GitHub repo, and this file.

## 2026-09-27: Tech stack confirmed as in blueprint v3

TypeScript everywhere. React + Vite web app, Express + Socket.io API, PostgreSQL + Prisma, Redis + BullMQ worker, real git on disk, OpenVSCode Server containers via dockerode. npm workspaces, ESLint, Prettier, Vitest, Playwright, GitHub Actions.

## 2026-09-27: Work split into frontend, backend and platform

Work is split between frontend (apps/web), backend (apps/api, apps/worker, packages/shared) and platform (Docker, IDE image, CI, tooling, deploy), with one lead who plans, reviews, runs checks and commits. Front end and back end share Zod schemas through a new `packages/shared` workspace.

## 2026-09-27: Local database name

The local PostgreSQL already has a `devspace` role and database from the old project, which we don't touch. This project uses `devspace_v3` (role, password and database) locally, set in the gitignored `apps/api/.env`. CI and `docker-compose.yml` keep `devspace`, since they start from empty databases.
