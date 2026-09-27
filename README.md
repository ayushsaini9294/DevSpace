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

5. Build the IDE image (OpenVSCode Server with Node.js 24) and create its network. At WSL boot, `/etc/wsl.conf` runs `scripts/ide-boot.sh`, which creates the network and applies the IDE firewall as root. Run it once by hand as root after setting it up. From Windows: `wsl -d Ubuntu -u root bash /home/ayush/devspace/scripts/ide-boot.sh`.

   ```sh
   npm run ide:build
   npm run ide:network
   ```

6. Start the web app, the API and the worker (which stops IDEs idle for 30 minutes and checks copy sizes):

   ```sh
   npm run dev
   ```

   Open http://localhost:5173.

### Ports

| Address                 | What                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `http://localhost:5173` | The web app (`APP_ORIGIN`); Vite forwards `/api` to the API                      |
| `http://localhost:3000` | The API (`PORT`)                                                                 |
| `http://127.0.0.1:3100` | The IDE listener (`IDE_PORT`, `IDE_HOST`, `IDE_ORIGIN`), bound to 127.0.0.1 only |

The IDE is served from `127.0.0.1` on purpose. The browser treats it as a different site from `localhost`, so code running in a member's IDE can never act as the app. Open the app at `localhost` and never at `127.0.0.1`. The IDE listener binds IPv4 `127.0.0.1` because WSL forwards Windows' `127.0.0.1` only to IPv4 listeners. Run `npm run ports:check` to see whether something else already holds 3000, 3100 or 5173.

## Commands

| Command               | What it does                                              |
| --------------------- | --------------------------------------------------------- |
| `npm run dev`         | Starts the web app, the API and the worker                |
| `npm run lint`        | Runs ESLint                                               |
| `npm run typecheck`   | Type-checks every workspace                               |
| `npm test`            | Runs unit and API tests (the API tests need the database) |
| `npm run test:e2e`    | Runs the Playwright browser tests                         |
| `npm run format`      | Formats the code with Prettier                            |
| `npm run ide:build`   | Builds the IDE image `devspace-ide:1`                     |
| `npm run ide:network` | Creates the Docker network IDE containers join            |
| `npm run ports:check` | Checks that ports 3000, 3100 and 5173 are free            |
