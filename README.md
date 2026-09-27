# DevSpace

A workspace for small teams (2–10 people). A leader creates a project, each member works on their own copy in a browser VS Code, members submit their work for review, and only leaders merge it into main, which can be published to GitHub. Git runs underneath, but nobody has to type Git commands.

The full design is in [`docs/blueprint.pdf`](docs/blueprint.pdf), and big choices are recorded in [`docs/decisions.md`](docs/decisions.md).

## Status

Built in 12 phases. Done so far:

- **Phase 1, Foundation:** monorepo, web and API apps, database, lint, tests, CI
- **Phase 2, Accounts:** sign up, log in, log out, sessions
- **Phase 3, Teams and projects:** teams, projects, invitations, roles and permissions
- **Phase 4, Repository:** each project's Git repository and a file browser for main

Next: Phase 5, Copies and IDE.

## Tech stack

TypeScript everywhere, in an npm workspaces monorepo.

| Part              | Technology                                                       |
| ----------------- | ---------------------------------------------------------------- |
| `apps/web`        | React, Vite, React Router, TanStack Query, Zustand, Tailwind CSS |
| `apps/api`        | Node.js, Express, Zod, Prisma, PostgreSQL                        |
| `packages/shared` | Zod schemas shared by the web app and the API                    |
| Tooling           | ESLint, Prettier, Vitest, Playwright, GitHub Actions             |

## Getting started

You need Linux (on Windows, WSL 2 Ubuntu), Node.js 24 and Docker Engine. From Phase 5 the API starts IDE containers through Docker's local socket, so run everything on the same Linux machine as Docker.

1. Install dependencies:

   ```sh
   npm install
   ```

2. Start PostgreSQL and Redis:

   ```sh
   npm run db:up
   ```

3. Copy `apps/api/.env.example` to `apps/api/.env`.

4. Create the tables:

   ```sh
   npm run db:migrate
   ```

5. Start the web app and the API:

   ```sh
   npm run dev
   ```

   Open http://localhost:5173. The API runs on http://localhost:3000.

## Commands

| Command             | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `npm run dev`       | Starts the web app and the API                            |
| `npm run lint`      | Runs ESLint                                               |
| `npm run typecheck` | Type-checks every workspace                               |
| `npm test`          | Runs unit and API tests (the API tests need the database) |
| `npm run test:e2e`  | Runs the Playwright browser tests                         |
| `npm run format`    | Formats the code with Prettier                            |
