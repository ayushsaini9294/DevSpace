# Putting DevSpace online

There are two ways to put DevSpace on the internet, with HTTPS, at your own address:

- **[Free: run it from your PC](#free-run-it-from-your-pc-cloudflare-tunnel)** with Cloudflare Tunnel and two free domains. No card, no server. DevSpace is online only while your PC is on, and a few people can have their IDE open at the same time.
- **[On a rented server](#on-a-rented-server)**: always online and room for more people, but it costs money (a card is needed).

You don't need to have run a server before. Do the steps in order. Each one says what to type and what you should see. Anything in `<angle brackets>` is a placeholder: replace it, brackets included, with your own value.

---

## Free: run it from your PC (Cloudflare Tunnel)

DevSpace runs inside Ubuntu (WSL) on your Windows PC, the same place you develop it. A free program from Cloudflare, `cloudflared`, connects your PC to Cloudflare. When someone opens your address, Cloudflare passes their visit through that connection to your PC. Cloudflare gives your site HTTPS, and nothing on your PC is opened to the internet.

You will need:

- a free Cloudflare account (no card);
- two free domains from [eu.org](https://nic.eu.org) (approval can take from a few days to several weeks, so start early);
- your PC with WSL Ubuntu, Docker and this repository (already set up if you develop DevSpace here);
- about an hour, plus the wait for eu.org.

DevSpace needs **two different domains**: one for the app (what people open) and one for the IDEs, where every member's IDE gets its own address like `3f2a…c1b0.ayush-ide.eu.org`. Two eu.org names such as `ayush-devspace.eu.org` and `ayush-ide.eu.org` are two separate domains, which is what DevSpace needs (eu.org is a "public suffix", like `.com`). Don't use one domain and a subdomain of it: code in a member's IDE could then plant cookies for the app.

Below, `<app domain>` means your app domain (e.g. `ayush-devspace.eu.org`) and `<IDE domain>` your IDE domain (e.g. `ayush-ide.eu.org`).

### F1. Make a Cloudflare account

Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up), sign up with your email and a password, and confirm your email. Cloudflare's free plan is enough for everything here. Nothing in this guide asks for a card. If Cloudflare ever asks you to pick a plan, pick **Free**.

### F2. Ask for your two eu.org domains

Cloudflare only accepts domains that already exist, and eu.org only gives you a domain once name servers answer for it. So the domains start on another free DNS service, **Hurricane Electric**, and move to Cloudflare once eu.org has approved them (step F3).

1. **Hurricane Electric**: go to [dns.he.net](https://dns.he.net), click **Register!**, and make a free account (no card). Log in, click **Add a new domain**, type `<app domain>` and click **Add Domain!**. It may warn that the domain isn't delegated to it yet. That's expected, because the domain doesn't exist yet. Do the same for `<IDE domain>`.
2. **eu.org**: go to [nic.eu.org](https://nic.eu.org), open the sign-up page and create an account (eu.org calls it a "contact" or "handle"). Confirm the email it sends you, then log in.
3. Click **New domain**. Type `<app domain>`, fill in your details, and under **Name servers** enter:

   ```
   ns1.he.net
   ns2.he.net
   ns3.he.net
   ns4.he.net
   ns5.he.net
   ```

   Submit. If the name server check fails, choose the option to check **server names only** and submit again.

4. Do the same for `<IDE domain>`.

eu.org approves requests by hand. You get an email for each domain when it's done. It can take days, sometimes weeks. While you wait, you can keep using DevSpace locally.

### F3. Move both domains to Cloudflare

Once **both** domains are approved:

1. In Cloudflare, click **Add a domain** (or **Add a site**), type `<app domain>`, and continue. Choose the **Free** plan. If Cloudflare offers to scan or import DNS records, keep the defaults; DevSpace doesn't need any of the old records.
2. Cloudflare shows **two name servers**, something like `ada.ns.cloudflare.com` and `bob.ns.cloudflare.com`. Write them down.
3. On [nic.eu.org](https://nic.eu.org), log in, open `<app domain>`, and change its name servers: remove the five `he.net` ones and enter Cloudflare's two. Save.
4. Do steps 1–3 for `<IDE domain>`. (Cloudflare usually gives you the same two name servers for both.)
5. Wait until Cloudflare shows each domain as **Active**. That takes from a few minutes to a day, and Cloudflare emails you. You can then delete both domains from Hurricane Electric.

Cloudflare makes a free HTTPS certificate for each domain by itself ("Universal SSL"). It covers the domain and every name one level under it, so `<app domain>` and every `<copy id>.<IDE domain>` are covered. This can take up to a day after the domain becomes Active. You can see it under the domain → **SSL/TLS** → **Edge Certificates**: the "Universal" certificate should say **Active**.

### F4. Make the tunnel and copy its token

1. In the Cloudflare dashboard, go to **Networking** → **Tunnels**. (In some accounts this is under **Zero Trust** → **Networks** → **Tunnels**. Both lead to the same place. If you are asked to pick a Zero Trust plan, pick **Free**.)
2. Click **Create a tunnel**. If asked for a type, choose **Cloudflared**. Name it `devspace` and click **Create Tunnel** (or **Save tunnel**).
3. Cloudflare now shows commands to install `cloudflared`. **Don't run them.** DevSpace runs `cloudflared` for you. Pick **Docker** (or any system). The command shown contains a long text starting with `eyJ`: that's the **tunnel token**. Copy that command or just the token. You'll paste it in step F7.
4. Click **Continue** / **Next** to go on to the routes (step F5).

The token lets anyone run your tunnel, so treat it like a password: don't put it in chats, screenshots or GitHub. If it ever leaks, delete the tunnel in Cloudflare, make a new one, and give DevSpace the new token with `bash deploy/live.sh token`.

### F5. Send both domains through the tunnel

Open your tunnel (**Networking** → **Tunnels** → `devspace`) → **Routes** → **Add route** → **Published application** (in older screens: the **Public Hostname** tab → **Add a public hostname**). Add these two routes:

| Subdomain          | Domain         | Path      | Service URL             |
| ------------------ | -------------- | --------- | ----------------------- |
| _(leave it empty)_ | `<app domain>` | _(empty)_ | `http://localhost:8080` |
| `*`                | `<IDE domain>` | _(empty)_ | `http://localhost:8080` |

(In older screens, the service is two fields: **Type** `HTTP` and **URL** `localhost:8080`.)

Then check the DNS records. Open each domain → **DNS** → **Records**. Cloudflare usually adds them for you. Each domain needs one record pointing at the tunnel:

| Domain         | Type    | Name | Target                         | Proxy status         |
| -------------- | ------- | ---- | ------------------------------ | -------------------- |
| `<app domain>` | `CNAME` | `@`  | `<tunnel ID>.cfargotunnel.com` | **Proxied** (orange) |
| `<IDE domain>` | `CNAME` | `*`  | `<tunnel ID>.cfargotunnel.com` | **Proxied** (orange) |

If one is missing (often the `*` one), click **Add record** and add it. The **tunnel ID** is the long ID shown on the tunnel's page (like `6ff42ae2-765d-4adf-8112-31c55c1551ef`). The cloud must be **orange** (Proxied): the visit has to go through Cloudflare to reach the tunnel. Delete any other `A`, `AAAA` or `CNAME` records for `@` or `*` on these two domains.

### F6. Two safety settings in Cloudflare

For **each** of the two domains:

1. **SSL/TLS** → **Edge Certificates**: turn **Always Use HTTPS** on, and set **Minimum TLS Version** to **TLS 1.2**.
2. **Scrape Shield** (in some accounts under **Security** → **Settings**): turn **Email Address Obfuscation** off. It changes web pages on the way through, which can break members' apps in the IDE's Preview.

Leave **Rocket Loader** off (it is off at first). It changes the app's scripts and breaks it.

### F7. Start DevSpace

Open the Ubuntu window and stop `npm run dev` if it's running (press `Ctrl+C` in its window). DevSpace can't run live and in development at the same time. Then:

```bash
cd ~/devspace
bash deploy/live.sh start
```

The first time, it asks three questions:

- **App domain**: type `<app domain>`;
- **IDE domain**: type `<IDE domain>`;
- **Tunnel token**: paste the token (or the whole command) from step F4. Nothing appears while you paste; that's on purpose. Press Enter.

It then makes the database password and the encryption key itself, saves everything in `~/devspace-live/.env` (only you can read it), builds DevSpace (5–15 minutes the first time) and starts it. It ends with:

```
live: DevSpace answers: {"ok":true,"db":true,"redis":true}
live: the tunnel is connected to Cloudflare (4 connections)
live: DevSpace is live at https://<app domain>
```

Your live DevSpace keeps its data in `~/devspace-live`, apart from your development data:

- `~/devspace-live/.env`: your settings and secrets. Keep a copy somewhere safe and private (e.g. a password manager). Never put it on GitHub. **Never change `POSTGRES_PASSWORD` or `AI_SECRETS_KEY`** once DevSpace has run.
- `~/devspace-live/data`: projects and members' copies.
- `~/devspace-live/backups`: backups (see below).

### F8. Make the first account

On your phone, turn Wi-Fi off (so it uses mobile data, like any visitor) and open `https://<app domain>`. Click **Sign up** and make your account. Then create a team and a project; whoever creates a project is its leader and invites the others from the project's **Members** page. Set up the repository, then click **Open IDE** to check that the IDE opens (the first time takes a little longer). Its address is `https://<copy id>.<IDE domain>`.

### F9. Keep it running

- **Keep the PC on and awake.** In Windows **Settings** → **System** → **Power & sleep**, set **Sleep** to **Never** while DevSpace is live. If the PC sleeps or turns off, DevSpace is offline until it's back.
- **Keep an Ubuntu window open.** WSL stops shortly after its last window closes, and DevSpace stops with it. Minimise the window instead of closing it.
- After a restart of the PC, open Ubuntu: DevSpace starts again by itself if it was running before. Check with `bash deploy/live.sh status`.

Everyday commands, from `~/devspace`:

| Command                                                                     | What it does                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `bash deploy/live.sh status`                                                | Is DevSpace running, is the tunnel connected, how many IDEs are open, how much memory is free.   |
| `bash deploy/live.sh stop`                                                  | Stops DevSpace (your data is kept). Do this before `npm run dev`.                                |
| `bash deploy/live.sh start`                                                 | Starts it again.                                                                                 |
| `bash deploy/live.sh logs` (or `logs api`, `logs cloudflared`)              | Shows what it's doing. `Ctrl+C` to leave.                                                        |
| `bash deploy/live.sh update`                                                | Rebuilds DevSpace from the code in `~/devspace` (after you pull or commit changes) and restarts. |
| `bash deploy/live.sh backup`                                                | Makes a backup now.                                                                              |
| `bash deploy/live.sh restore ~/devspace-live/backups/<backup folder> --yes` | Puts a backup back (everything changed after it is lost).                                        |
| `bash deploy/live.sh token`                                                 | Replaces the tunnel token (after making a new tunnel).                                           |

**Backups** are made every night at 03:00 if the PC is on, into `~/devspace-live/backups`; the newest 7 are kept. Each holds the database, the projects' repositories and members' copies (see [Backups and restoring](#12-backups-and-restoring) for what's inside). Now and then, copy the newest one off the PC, e.g. to a USB stick or cloud drive: in Windows Explorer they are at `\\wsl$\Ubuntu\home\<your Ubuntu user>\devspace-live\backups`.

### F10. Know the limits

- **Offline when the PC is.** If your PC is off, asleep, or WSL is closed, nobody can reach DevSpace. Visitors see a Cloudflare error page until it's back. Nothing is lost.
- **A few IDEs at once.** Ubuntu (WSL) on this PC has about 7.8 GB of memory. Measured on this PC: DevSpace itself uses about 0.5 GB when idle; one open IDE used about 0.5 GB while in use and about 0.2 GB idle. Each IDE may grow to 2 GB while it installs packages or builds (that's its limit). About **4 people with their IDE open at the same time** is comfortable; more than 6 at once can run the PC out of memory. IDEs nobody uses stop by themselves after 30 minutes. `bash deploy/live.sh status` shows how much memory is free.
- **Your PC does the work.** Builds and tests in members' IDEs use your PC's processor. Don't run heavy things (e2e tests, `docker build`) while people are using it.
- **DevSpace controls Docker in your Ubuntu.** To start members' IDEs, it has full control of Docker inside WSL, and through it of everything in your Ubuntu (including your development files, and your Windows drives under `/mnt/c`). Members' code runs locked inside IDE containers that can't reach your PC, but invite only people you trust, keep the PC's own files backed up, and move to a rented server when DevSpace is used by people you don't know.
- **Not with `npm run dev`.** Stop the live DevSpace (`bash deploy/live.sh stop`) before `npm run dev`, and stop `npm run dev` before `bash deploy/live.sh start`.

### If something goes wrong (free mode)

| What you see                                                               | What to do                                                                                                                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live: npm run dev is running…`                                            | Stop `npm run dev` (`Ctrl+C` in its window), then start again.                                                                                                              |
| `the tunnel isn't connected to Cloudflare yet`, or `Tunnel: NOT connected` | `bash deploy/live.sh logs cloudflared`. "Provided Tunnel token is not valid": paste the token again with `bash deploy/live.sh token`. Other errors: check the PC is online. |
| Cloudflare page "Error 1033" or "Argo Tunnel error"                        | The tunnel isn't connected: see the line above.                                                                                                                             |
| Cloudflare page "Error 502" or "Bad gateway"                               | DevSpace isn't answering on the PC: `bash deploy/live.sh status`, then `bash deploy/live.sh logs api`. Check the routes in step F5 say `http://localhost:8080`.             |
| The app opens but **Open IDE** shows a Cloudflare error or "not found"     | Check the `*` route on `<IDE domain>` (step F5) and its `*` DNS record (orange cloud).                                                                                      |
| A certificate warning on the IDE                                           | Universal SSL may not be ready yet (step F3, up to a day). In **SSL/TLS** → **Edge Certificates**, the Universal certificate must list `*.<IDE domain>`.                    |
| `only … MB of memory is free`                                              | Close programs, stop IDEs you don't need, or stop the development database (`docker compose stop` in `~/devspace`).                                                         |
| `the IDE network is missing`                                               | Close every Ubuntu window, run `wsl --shutdown` in Windows PowerShell, open Ubuntu again, and start again.                                                                  |
| "Too many tries. Please wait a minute and try again."                      | DevSpace limits how often someone can log in or sign up. Wait, then try again.                                                                                              |

**Before inviting real users**, go through the checklist at the [end of this guide](#before-inviting-real-users) (the parts about the server don't apply; your `.env` is `~/devspace-live/.env`).

---

## On a rented server

You will need:

- about an hour;
- a credit or debit card (the server is about €5–25 a month; the two domains are about €10–40 a year each);
- a computer with a terminal (on Windows, the Ubuntu terminal from WSL or PowerShell both work).

> **Important: DevSpace needs a server of its own.** To start members' IDEs, DevSpace controls Docker on the server, and that means it controls the whole server. Don't put other websites or services on the same machine.

---

## 1. Rent a server

Rent an **Ubuntu 24.04** server with at least **4 GB of memory** (8 GB if more than five people will have their IDE open at the same time) and 80 GB of disk.

- **Hetzner Cloud** (cheapest in Europe): create a project → _Add Server_ → a location near you → image **Ubuntu 24.04** → a shared-vCPU type with **4 GB or 8 GB** of memory → add your SSH key (see below) → _Create & Buy now_.
- **DigitalOcean**: _Create_ → _Droplets_ → **Ubuntu 24.04 (LTS)** → _Basic_ → _Regular_, **4 GB / 2 CPUs** or larger → add your SSH key → _Create Droplet_.

(Provider menus change from time to time. What matters is Ubuntu 24.04, 4 GB+ of memory and your SSH key.)

**SSH key.** This is how you log in safely, without a password. If you don't have one yet, make it on your own computer:

```bash
ssh-keygen -t ed25519
cat ~/.ssh/id_ed25519.pub
```

Press Enter at each question. Copy the line the second command prints and paste it where the provider asks for an SSH key.

When the server is ready, the provider shows its **IPv4 address**, something like `203.0.113.10`. Write it down. Log in from your computer:

```bash
ssh root@<server IP>
```

Type `yes` the first time. You are now on the server, and the prompt ends in `#`. Every command from here on runs on the server unless the step says otherwise.

Bring it up to date first:

```bash
apt update && apt upgrade -y
```

---

## 2. Buy two domains and put both on Cloudflare

DevSpace needs **two different domains**:

- one for the app itself, e.g. `teamspace.dev`. People open this address.
- one for the IDEs, e.g. `teamspace-ide.dev`. Every member's IDE gets its own address under it, like `3f2a…c1b0.teamspace-ide.dev`.

They must be **two separate domains**, not one domain and a subdomain of it (`ide.teamspace.dev` won't do). Browsers treat a domain and its subdomains as one "site", and code running in a member's IDE could then plant cookies for the app. With two domains, the IDEs can never touch the app.

1. Make a free account at [cloudflare.com](https://dash.cloudflare.com/sign-up).
2. Buy both domains. The simplest way is Cloudflare itself: _Domain Registration_ → _Register Domains_. Domains bought there are already on Cloudflare.
3. If you bought them somewhere else, add each one to Cloudflare (_Add a domain_ → the free plan). Cloudflare shows two **nameservers**. At the company you bought the domain from, replace its nameservers with those two. It can take from a few minutes to a day before Cloudflare shows the domain as **Active**.

---

## 3. Point both domains at your server

In Cloudflare, open each domain → **DNS** → **Records** → **Add record**:

| Domain     | Type | Name | IPv4 address  | Proxy status |
| ---------- | ---- | ---- | ------------- | ------------ |
| app domain | `A`  | `@`  | `<server IP>` | **DNS only** |
| IDE domain | `A`  | `*`  | `<server IP>` | **DNS only** |
| IDE domain | `A`  | `@`  | `<server IP>` | **DNS only** |

Click the orange cloud until it turns **grey** ("DNS only"). DevSpace makes its own HTTPS certificates, and the IDE needs a direct connection.

To check, run this on your own computer after a few minutes. It should print your server's IP:

```bash
ping -c 1 <app domain>
ping -c 1 anything.<IDE domain>
```

---

## 4. Make a Cloudflare API token

The IDE domain gets one "wildcard" certificate that covers every member's IDE address. To prove you own the domain, DevSpace briefly adds a DNS record through Cloudflare, so it needs a token for that.

1. In Cloudflare, click your profile picture (top right) → **My Profile** → **API Tokens** → **Create Token**.
2. Next to **Edit zone DNS**, click **Use template**.
3. **Permissions**: keep `Zone` · `DNS` · `Edit`, then click **+ Add more** and add `Zone` · `Zone` · `Read`.
4. **Zone Resources**: `Include` · `Specific zone` · **your IDE domain**.
5. **Continue to summary** → **Create Token**.
6. Copy the token now. Cloudflare shows it only once. You'll paste it in step 7.

---

## 5. Install Docker

On the server:

```bash
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

The last two commands should print version numbers (Docker 27 or newer, Compose v2 or newer). If either one says "command not found", run the first line again.

---

## 6. Get DevSpace and prepare the server

Download DevSpace into `/opt/devspace`:

```bash
git clone https://github.com/<your GitHub name>/<repository name>.git /opt/devspace
cd /opt/devspace
```

If the repository is private, git asks for a username and a password. Enter your GitHub username, and as the password a **personal access token**. To make one on GitHub: _Settings_ → _Developer settings_ → _Personal access tokens_ → _Fine-grained tokens_ → _Generate new token_ → only this repository → _Contents: Read-only_.

Then run the setup script once:

```bash
bash deploy/host-setup.sh
```

It takes a few minutes the first time. It:

- makes the user DevSpace runs as, and its folders: `/srv/devspace/data` (projects and members' copies) and `/srv/devspace/backups`;
- makes your settings file, `deploy/.env`, with a database password and an encryption key already filled in;
- sets up the IDE network and firewall, so a member's IDE can reach the internet but nothing else on the server, and makes them come back by themselves after every restart;
- builds the IDE image (VS Code in the browser).

It ends by telling you which settings are still missing.

---

## 7. Fill in your settings

Open the settings file:

```bash
nano deploy/.env
```

Fill in these four lines (no spaces around `=`, no quotes):

```ini
APP_DOMAIN=<app domain, e.g. teamspace.dev>
IDE_DOMAIN=<IDE domain, e.g. teamspace-ide.dev>
ACME_EMAIL=<your email, for certificate expiry notices>
CLOUDFLARE_API_TOKEN=<the token from step 4>
```

Save with `Ctrl+O` then Enter, and leave with `Ctrl+X`.

`POSTGRES_PASSWORD` and `AI_SECRETS_KEY` are already filled in. **Never change them once DevSpace is running.** A new database password locks DevSpace out of its own data. A new `AI_SECRETS_KEY` means every member has to connect OpenRouter again. If you ever need to make them by hand, these commands print a fresh value:

```bash
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -base64 32   # AI_SECRETS_KEY
```

Keep a copy of `deploy/.env` somewhere safe and private, e.g. a password manager. Never put it on GitHub. The repository already ignores it.

---

## 8. Start DevSpace

```bash
cd /opt/devspace/deploy
docker compose up -d --build
```

The first start builds DevSpace, which takes about 5–10 minutes. Then check that everything is running:

```bash
docker compose ps
```

You should see `caddy`, `api`, `worker`, `postgres`, `redis` and `backup` as **running** (`api`, `postgres` and `redis` also say **healthy**), and `migrate` as **exited (0)**. That one only runs once, to set up the database.

Open `https://<app domain>` in your browser. The very first visit can take up to a minute while the certificates are made.

---

## 9. Make the first account

On `https://<app domain>`, click **Sign up** and make your account. Then create a team and a project. Whoever creates a project is its leader, and invites the others from the project's **Members** page.

Check that the IDE works: in your project, set up the repository, then click **Open IDE**. VS Code should open inside the page after a little while (the first time takes longer).

---

## 10. Optional: connect GitHub

Only needed if you want to publish projects to GitHub. If you already made a DevSpace GitHub App for testing, open it on GitHub (_Settings_ → _Developer settings_ → _GitHub Apps_ → your app → _Edit_) and set:

- **Callback URL**: `https://<app domain>/settings/github/callback`
- **Homepage URL**: `https://<app domain>`

Then copy the app's private key file (`.pem`) to the server. Run this on your own computer:

```bash
scp <path to the .pem file> root@<server IP>:/srv/devspace/secrets/github-app.pem
```

and on the server:

```bash
chown 10001:10001 /srv/devspace/secrets/github-app.pem
chmod 400 /srv/devspace/secrets/github-app.pem
```

Fill in the GitHub lines in `deploy/.env`:

```ini
GITHUB_APP_ID=<App ID>
GITHUB_APP_SLUG=<the app's name as it appears in its URL>
GITHUB_CLIENT_ID=<Client ID>
GITHUB_CLIENT_SECRET=<a client secret>
GITHUB_APP_PRIVATE_KEY_FILE=/srv/devspace/secrets/github-app.pem
```

and restart: `docker compose up -d`.

---

## 11. Updating DevSpace

When there's a new version on GitHub:

```bash
cd /opt/devspace
git pull
bash deploy/host-setup.sh        # refreshes the IDE image and the firewall; safe to repeat
cd deploy
docker compose up -d --build
```

Database changes are applied by themselves (the `migrate` step) before the new version starts. Members' copies, projects and settings are kept. People using DevSpace may see it reconnect for a few seconds.

---

## 12. Backups and restoring

**Every night at 03:00** (server time), DevSpace saves a backup to `/srv/devspace/backups/<date and time>/`. Each backup holds:

- `db.dump`: the database (accounts, projects, submissions, comments, …);
- `repos.tar.zst`: every project's Git repository;
- `copies.tar.zst`: every member's copy, with work they haven't submitted yet. Folders that can be rebuilt (`node_modules`, `.venv`, `dist`, `build`, `.next`, `.cache`) are left out;
- `manifest.json`: the size and checksum of each file.

The newest **7** backups are kept. Older ones are deleted only after a new backup has finished and been checked.

See what's there, and what the last backup said:

```bash
ls /srv/devspace/backups
cd /opt/devspace/deploy && docker compose logs backup
```

Make a backup right now (before an update, for example):

```bash
cd /opt/devspace/deploy
docker compose exec backup devspace-backup
```

**Backups on the same server don't help if the server itself is lost.** Now and then (weekly is good), copy the newest backup to your own computer. Run this on your computer:

```bash
scp -r root@<server IP>:/srv/devspace/backups/<backup folder> .
```

**Restoring** puts the database, the repositories and the copies back as they were in one backup. **Everything changed after that backup is lost.** The folders it replaces are kept in `/srv/devspace/data/.before-restore-<time>/`, in case you need something from them.

```bash
cd /opt/devspace
bash deploy/restore.sh /srv/devspace/backups/<backup folder> --yes
```

DevSpace is unavailable for the minute or so this takes. Without `--yes`, the script only says what it would do.

To restore onto a **new** server: do steps 1–8 there, using the same `deploy/.env` (the same `POSTGRES_PASSWORD` and `AI_SECRETS_KEY`). Copy the backup folder into `/srv/devspace/backups/`, then run the restore command above.

---

## 13. If something goes wrong

Start by looking at what's running and what it says:

```bash
cd /opt/devspace/deploy
docker compose ps
docker compose logs --tail 50 api
docker compose logs --tail 50 caddy
```

| What you see                                                                  | What to do                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose up` says `set APP_DOMAIN in deploy/.env` (or another setting) | That setting is empty in `deploy/.env`. Fill it in (step 7).                                                                                                                                                           |
| `docker compose up` says `run deploy/host-setup.sh first`                     | Run `bash deploy/host-setup.sh` from `/opt/devspace` (step 6).                                                                                                                                                         |
| `api` keeps restarting                                                        | `docker compose logs api` says why, one line per problem, e.g. a missing or wrong setting. Fix it in `deploy/.env`, then `docker compose up -d`.                                                                       |
| `migrate` says `exited (1)`                                                   | `docker compose logs migrate`. Usually the database password in `deploy/.env` was changed after the first start. Put the original one back.                                                                            |
| The browser says the site can't be reached                                    | Check the DNS records (step 3): `ping <app domain>` must print the server's IP. Check that your provider's firewall (if you turned one on) allows ports 80 and 443.                                                    |
| A certificate warning, or `caddy` logs say `obtaining certificate` failed     | For the app: the DNS record must be **DNS only** (grey cloud), and ports 80 and 443 must be open. For the IDE: check `CLOUDFLARE_API_TOKEN` and its permissions (step 4). After a fix: `docker compose restart caddy`. |
| The app works but **Open IDE** spins forever or fails                         | Check the IDE image exists: `docker image ls devspace-ide`. Check the firewall service ran: `systemctl status devspace-ide-net`. Running `bash deploy/host-setup.sh` again fixes both.                                 |
| "Too many tries. Please wait a minute and try again."                         | DevSpace limits how often someone can log in or sign up. Wait, then try again.                                                                                                                                         |
| The disk is full                                                              | `df -h /` shows how full it is. Delete old `.before-restore-*` folders in `/srv/devspace/data`, then old images with `docker image prune`. DevSpace flags any member's copy that grows over 5 GB.                      |

To restart everything: `docker compose restart`. To stop everything (data is kept): `docker compose down`. **Never** add `-v` to `down`: that deletes the database.

---

## Before inviting real users

Do these once, before anyone else uses your DevSpace:

- [ ] **Rotate the GitHub App's secrets** if you connected GitHub. A client secret or private key that was ever on another computer, in a chat or in a test setup should be replaced: on GitHub, generate a new client secret and a new private key, delete the old ones, and update `deploy/.env` and `/srv/devspace/secrets/github-app.pem`.
- [ ] **Use a fresh `AI_SECRETS_KEY`.** `host-setup.sh` makes a new one. Never reuse the one from your development computer.
- [ ] **Set your OpenRouter key.** Each member connects their own OpenRouter key in DevSpace's AI settings. Do it for your own account and check that an AI review works.
- [ ] **Check a backup exists** the morning after going live (`ls /srv/devspace/backups`), and copy one to your own computer.
- [ ] **Keep `deploy/.env` safe**: a private copy off the server, never on GitHub.
