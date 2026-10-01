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

## 2026-09-28: Presence and notifications (Phase 9)

- DevSpace's own tracker extension comes pre-installed in every IDE and reports the open file and whether the member is active. Reports go through the IDE's logged-in connection, so they are tied to the person actually using the IDE; the server treats them as untrusted and only shows plain text.
- Teammates see each member as Active (with the open file), Online, or Offline with "last seen". Each member can switch off sharing their open file and then just shows as Active (owner).
- Live updates use Socket.io with Redis. Only members of a project receive its events, and events only say what changed; the page then reloads that data through the normal permission checks.
- In-app notifications, never sent to the person who did the action. New submissions notify leaders, co-leaders and members with the Approve permission (owner).
- When main's package.json or package-lock.json changes, members get a reminder to run npm install (owner).
- Notifications are kept for 30 days, then deleted automatically (owner).
- The IDE site allows framing by itself as well as by the app (`frame-ancestors 'self' <app>`), because VS Code runs its extensions in a nested iframe from the IDE's own address.
- Known risk, accepted for now (owner): every copy's IDE shares one address, so code planted in a member's container could reach another IDE that a leader opening that copy is also logged into. Before anyone else uses DevSpace, Phase 12 gives each copy's IDE its own address, so browsers keep copies fully apart.

## 2026-09-28: AI review (Phase 10)

- Members connect their own OpenRouter account with OpenRouter's login flow (OAuth with PKCE). DevSpace stores the key encrypted and never sends it to the browser; Disconnect deletes it.
- Default free models: qwen/qwen3.8-27b, nvidia/nemotron-3-ultra-550b-a55b and google/gemma-4-31b-it; fallbacks in order: poolside/laguna-s-2.1, nvidia/nemotron-3-super-120b-a12b, openrouter/free. They live in one config setting so they can be swapped as OpenRouter's free list changes (owner). A 3-model review uses about 3 of the 50 free daily requests, so about 15 reviews a day per member.
- AI review sends code to outside AI providers, so each project has a switch for it, off by default; leaders turn it on. Members see a one-time notice before their first review (owner).
- Paid models are opt-in: free by default, and an Advanced picker with a clear "uses your credits" confirmation (owner).
- "Review with my IDE AI" puts the changes and a review instruction into the reviewer's own copy (in a `.devspace/` folder that is never submitted). A VS Code command, "DevSpace: Send review findings", sends the findings back to the submission (owner).
- AI output is shown as plain text only. Tests and CI use a stand-in OpenRouter server; the real check uses the owner's account and real free models.

## 2026-09-29: DevSpace is the team hub for any AI coding tool (owner)

- DevSpace does not try to compete with AI coding tools such as Antigravity, Claude Code or Cursor. Members write code with whatever AI tool they like; DevSpace is where a team's work is reviewed (by people and by several AI models), merged safely by leaders, undone if needed, and tracked, without anyone having to learn Git.
- A new phase is added after Phase 10: **Phase 11, Connect your own IDE**. A member connects a desktop tool (Antigravity, Claude Code, Cursor, VS Code) to their own DevSpace copy through Git with a personal token, and their pushes land in that copy; from there the normal flow applies (Submit work, review, merge). Access is limited to the member's own copy, and main still changes only through a merge. The browser IDE stays for quick edits and for members without their own tool.
- The later phases move up by one: GitHub becomes Phase 12 and Deploy becomes Phase 13. The required per-copy IDE address fix moves with Deploy (Phase 13) and still must be done before anyone else uses DevSpace.
- A built-in AI agent in the browser IDE (for example Cline pre-installed and connected to the member's AI account) stays an idea for after launch.

## 2026-09-29: Talk to users before building more (owner)

- Open question: who DevSpace is for. (A) teams that aren't Git experts, where DevSpace hides Git and connects any AI tool to a member's copy; (B) an add-on for teams already on GitHub, adding AI cross-review, tasks and presence on top of pull requests; or (C) classrooms, where a teacher sees and reviews every student's work in zero-setup IDEs.
- Decision: finish the Phase 10 check, then pause new phases while the owner talks to 3–5 real teams. The Phase 11 "Connect your own IDE" plan stays on hold until the direction is chosen from their answers.

## 2026-09-29: DevSpace is for people new to programming who don't know GitHub (owner)

- Target users: beginners and teams of beginners who don't know Git or GitHub. DevSpace hides Git, needs no setup, keeps main safe through review and leader merges, and makes mistakes easy to undo. This replaces the earlier "talk to teams first" pause (the owner chose to plan now).
- The remaining phases, in order:
  - **Phase 11, Beginner start:** starter templates when setting up a repository (Empty, Node.js, React + Vite, Python, plain HTML/CSS/JS), each with a correct `.gitignore`; a guided first-time tour; simple wording and short help on every page.
  - **Phase 12, Built-in AI helper:** an AI coding assistant ready in every browser IDE, connected to the member's own AI account without copying keys. How the key is kept away from others who can open the copy (such as helping leaders) is decided when the phase starts.
  - **Phase 13, GitHub** (was Phase 12): publish once or keep updated, so beginners' projects end up on GitHub for their portfolio.
  - **Phase 14, Deploy** (was Phase 13): hosting, HTTPS, backups, rate limits, and the required separate address for each copy's IDE before anyone else uses DevSpace.
- "Connect your own IDE" (desktop Antigravity, Claude Code, Cursor, VS Code through Git) moves to after launch, since beginners mostly won't use it.

## 2026-09-29: Beginner start (Phase 11)

- Starter templates (owner): Empty, HTML/CSS/JS website, Node.js (Express), React + Vite, Full-stack (React + Express), and Python. Each comes with a simple README on how to run, preview and submit, and a correct `.gitignore`.
- Python 3 is added to the IDE image so the Python template runs (owner).
- A Preview button opens the app running in the member's IDE in a new tab, through DevSpace's IDE site with the same login rules as the IDE (owner). Templates are set up to work under the preview path; apps that use absolute paths may not load in Preview.
- The first-time guide is a "Getting started" checklist on the project page whose steps tick themselves when the member really does them (owner).
- The app stays in English for now, written in plain words for beginners with short help tips and no Git jargon (owner).

## 2026-09-30: Built-in AI helper (Phase 12)

- Every IDE comes with an AI coding agent like Cline, already connected to the member's own AI account, so beginners can ask it to build things with no setup (owner).
- The member's real key never enters their IDE. The assistant talks to a DevSpace AI gateway with a stand-in key that works only for that copy and only from its container; DevSpace adds the real, encrypted key on the server. A leader helping inside a copy can use the assistant as that member but can never see the key (owner).
- IDE containers may reach the gateway's one port on the host and nothing else there.
- Free models by default; a member can allow paid models for themselves, with a clear credits warning (owner).
- The project's AI switch covers both AI review and the IDE assistant; it stays off by default (owner).
- The built-in assistant is Cline (pinned version), connected through the gateway with no setup. It may read the member's files, but always asks before editing files, running commands, using a browser or MCP tools.
- Anything that could spend credits needs "Allow paid models", not only a paid model name: fallback model lists with paid models and paid plugins such as web search count too.
- The IDE no longer shows VS Code's "Do you trust the authors?" prompt, since the isolated container is the safety boundary and the folder is the member's own copy; and VS Code's own Copilot chat is hidden, since it doesn't work here and Cline is the assistant (owner).

## 2026-10-01: GitHub (Phase 13)

- DevSpace connects to GitHub only through its own GitHub App, which the owner registers. Each member can connect their GitHub account; DevSpace keeps their tokens encrypted.
- Publishing creates a new repository on the publisher's GitHub account and pushes main with its full history. New repositories are private unless the person ticks "Make it public" (owner).
- From now on, commits made by DevSpace use private email addresses: the person's GitHub "noreply" address when they connected GitHub (so commits show on their GitHub profile), otherwise a DevSpace private address. Before publishing, DevSpace warns which people's real email addresses are in older commits (owner).
- In "keep updated" mode DevSpace pushes main after every merge or undo, never force-pushes, and pauses with an explanation if someone changed the repository directly on GitHub (owner). Bringing GitHub changes back into DevSpace stays a later feature.
- Leaders can start a project by importing a GitHub repository, private ones included.
