# DevSpace

A workspace for small teams (2–10 people). A leader creates a project, each member works on their own copy in a browser VS Code, members submit their work for review, and only leaders merge it into main, which can be published to GitHub. Git runs underneath, but nobody has to type Git commands.

The full design is in [`docs/blueprint.pdf`](docs/blueprint.pdf), and big choices are recorded in [`docs/decisions.md`](docs/decisions.md).

## Status

Built in 12 phases. Done so far:

- **Phase 1, Foundation:** monorepo, web and API apps, database, lint, tests, CI
- **Phase 2, Accounts:** sign up, log in, log out, sessions

Next: Phase 3, Teams and projects.

## Tech stack

TypeScript everywhere, in an npm workspaces monorepo.

| Part              | Technology                                                       |
| ----------------- | ---------------------------------------------------------------- |
| `apps/web`        | React, Vite, React Router, TanStack Query, Zustand, Tailwind CSS |
| `apps/api`        | Node.js, Express, Zod, Prisma, PostgreSQL                        |
| `packages/shared` | Zod schemas shared by the web app and the API                    |
| Tooling           | ESLint, Prettier, Vitest, Playwright, GitHub Actions             |

## Getting started

You need Node.js 24 and PostgreSQL 17.

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a database user and database for DevSpace (the names are up to you):

   ```sh
   psql -U postgres -h localhost -c "CREATE ROLE devspace LOGIN CREATEDB PASSWORD 'devspace';" -c "CREATE DATABASE devspace OWNER devspace;"
   ```

   With Docker, `npm run db:up` starts PostgreSQL and Redis from `docker-compose.yml` instead.

3. Copy `apps/api/.env.example` to `apps/api/.env` and set `DATABASE_URL` to match your database.

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
