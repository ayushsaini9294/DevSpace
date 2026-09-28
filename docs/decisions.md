# Decisions

Big choices, newest last. The blueprint (`docs/blueprint.pdf`, v3) is the source of truth; this file records how we apply it.

## 2026-09-27: Project location and fresh start

- The project lives in `D:\Projects\devspace` (C: had only 15 GB free; Docker and IDE containers need space).
- This is a clean start from blueprint v3. Nothing is reused from the earlier `D:\DevSpace` attempt, which followed the old v2 design.

## 2026-09-27: Phase 0 added before Phase 1

Phase 0 sets up the machine and repo: Docker Engine inside WSL 2 Ubuntu (Docker Desktop will not install on this Windows build, and upgrading Windows is too risky for existing data), GitHub CLI, a private GitHub repo, and this file.

## 2026-09-27: Tech stack confirmed as in blueprint v3

TypeScript everywhere. React + Vite web app, Express + Socket.io API, PostgreSQL + Prisma, Redis + BullMQ worker, real git on disk, OpenVSCode Server containers via dockerode. npm workspaces, ESLint, Prettier, Vitest, Playwright, GitHub Actions.

## 2026-09-27: Work split into frontend, backend and platform

Work is split between frontend (apps/web), backend (apps/api, apps/worker, packages/shared) and platform (Docker, IDE image, CI, tooling, deploy), with one lead who plans, reviews, runs checks and commits. Front end and back end share Zod schemas through a new `packages/shared` workspace.

## 2026-09-27: Local database name

The local PostgreSQL already has a `devspace` role and database from the old project, which we don't touch. This project uses `devspace_v3` (role, password and database) locally, set in the gitignored `apps/api/.env`. CI and `docker-compose.yml` keep `devspace`, since they start from empty databases.

## 2026-09-27: Teams, projects and invitations (Phase 3)

- A team can hold several projects, each with its own leader (the blueprint's open question: yes).
- Any team member can create a project in that team and becomes its leader. Anyone logged in can create a team.
- You see only the projects you are a member of. Accepting a project invitation also adds you to its team.
- Invitations are for one email address. The leader copies the link and sends it; the link only works when logged in with that email. Links last 7 days; re-inviting the same email replaces the old link. Only a hash of the link token is stored.
- New members start with every extra permission switched off, as in the blueprint; leaders switch them on per member.
- Default project settings: approval required on, browsing others' copies off, copies update automatically, GitHub mode "publish once".
- Permission rules live in one pure function in `packages/shared` (`can`, plus member-management checks), used by the API to enforce and by the web app to show or hide actions.
- Login rate limiting moves to Phase 12, where the blueprint puts rate limits.

## 2026-09-27: Project repository (Phase 4)

- Each project gets one bare Git repository on the server at `<REPOS_DIR>/<projectId>.git` (default `.data/repos` in the repo root, gitignored). Its `main` branch is the project's main. Deleting a project deletes its repository.
- A leader or co-leader sets up the repository once (new action `repository.setup`): start empty (a first commit with a README, credited to them) or import from a Git link.
- Imports: https links from github.com, gitlab.com and bitbucket.org only, no credentials in the link, redirects not followed; at most 200 MB and 5 minutes; the source's default branch becomes `main`, with full history. Private repos wait for the GitHub App in Phase 11.
- Imports run in the background inside the API process, with a status the page polls (none, importing, ready, failed). They move to the BullMQ worker once Redis is available (Docker, Phase 5). An import interrupted by a restart is marked failed on startup, so it can be retried.
- Git runs as real `git` with fixed arguments and no shell, a timeout, prompts and hooks off, and only the https protocol allowed.
- The file browser reads `main` only. Files over 1 MB or binary files are listed but not shown. Files are shown in a read-only Monaco editor, the same editor the review page uses in Phase 6.

## 2026-09-27: Copies and IDE containers (Phase 5)

- Default limits per copy's IDE container: 1 CPU, 2 GB memory, 5 GB disk. About five IDEs fit at once on the 16 GB development PC.
- IDE containers can reach the internet (so `npm install` works) but not the host machine, the local network, or other containers.
- Development moves into WSL 2 Ubuntu (the safest option): the repo, Node, the API and the web dev server run there, and PostgreSQL and Redis run from Docker Compose. The API talks to Docker through its local socket, so Docker is never reachable over the network. The browser on Windows still opens the app at `localhost`.
- The IDE image includes Node.js 24 LTS with npm, so `npm install` works in the IDE terminal. Packages that compile native code need a compiler toolchain, which is left out for now.
- The IDE runs on its own site, never on the app's address, so code running in a member's container can't act as that member in DevSpace. In development the app is at `http://localhost:5173` and the IDE at `http://127.0.0.1:3100`; in production the IDE gets its own domain. The app hands the browser a one-time launch link (single use, valid 60 seconds), which gives the IDE its own short-lived cookie. The API also refuses changes that come from any other address.

## 2026-09-28: Submissions and review (Phase 6)

- Members don't need to commit in the IDE. Submitting reads the ticked files straight from the copy's folder and makes a hidden snapshot commit in the project's repository. The copy and main are not touched.
- A submission is compared with the version of main the copy was made from, so newer changes to main never look like the member undid them.
- The API treats everything in a copy folder as untrusted, including its `.git` folder and symlinks. It never runs git inside a copy and never follows a link out of it.
- Updating a submission resets its approvals: status goes back to Open and it needs a fresh approval (owner).
- Accepting a suggested fix writes it into the author's copy and updates the submission in one click (owner).
- Comments stay after an update; ones whose line changed are marked "outdated" (owner).
- Only leaders and co-leaders reject, with a reason. Members with the Approve permission approve or request changes (owner, as in the blueprint).
- Everyone in the project can see every submission. The author can always comment on their own submission, to reply.

## 2026-09-28: Merge, conflicts, undo and copy updates (Phase 7)

- Each merge is one new commit on main, credited to the submission's author; the leader who merged is recorded as committer. All merging happens in the project's repository; the server still never runs git inside a member's copy.
- When main changes, every open submission is re-checked; one that now conflicts shows Needs update until the author updates their copy and the submission.
- Updating a copy never overwrites the member's work. In automatic mode, a copy whose update would conflict is left untouched and the member is told. When they click Update my copy, clashing lines are written into the file between conflict markers (`<<<<<<< your copy` / `>>>>>>> main`) for them to resolve in VS Code (owner).
- Undo adds a new commit that reverses the merge. If later merges changed the same lines, undo is refused with a list of the files, so main is never left half-undone (owner).
- After an undo, the author's files stay as they are in their copy and show up again as changed files they can fix and resubmit; other copies lose the change as normal (owner).
- Leaders and co-leaders can open any member's copy in the IDE at any time. Every time is logged, and the member sees who opened their copy (owner).

## 2026-09-28: Tasks (Phase 8)

- Assignees move their own tasks between To do and In progress; leaders and co-leaders move any task anywhere. In review is set by linked submissions, and Done only by a leader (owner).
- If a task's linked submission is rejected or closed and no other linked submission is open, the task goes back to In progress (owner).
- If the merge of a Done task's linked submission is undone, the task goes back to In progress with a note saying why (owner).
- The board supports drag and drop, plus a status menu on each card for keyboard and phone use (owner).
- A submission links at most one task; a task can have many submissions. Done tasks can't be linked to new submissions.
- Leaders answer "Mark this task done?" after a linked merge; "Not yet" returns the task to In progress unless other linked work is still open.
