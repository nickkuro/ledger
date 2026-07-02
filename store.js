# Ledger (with Discord login)

A small notes app with Markdown, tags, search, dark/light themes, and "Continue
with Discord" login, so a group of people can each have their own private
notes on one shared site. Everyone's data lives in `data/db.json` on the
server, not in a browser, so notes follow you between devices.

This is a real server, not a static page, because Discord login requires a
client secret that has to stay off the internet entirely except in direct
requests between your server and Discord. There's no way to do that safely
from a page running purely in someone's browser.

## 1. Register a Discord application

1. Go to https://discord.com/developers/applications and create a new application.
2. Open **OAuth2** in the sidebar. Note the **Client ID** and **Client Secret**
   (click "Reset Secret" if one isn't shown yet).
3. Under **Redirects**, add the exact URL your server will use, for example:
   - Local testing: `http://localhost:3000/auth/discord/callback`
   - After deploying: `https://your-domain.com/auth/discord/callback`
   You can add both at once and switch between them as needed.

## 2. Configure the app

```bash
cp .env.example .env
```

Fill in `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_REDIRECT_URI`
to match what you set up above. Generate a `SESSION_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

If you only want specific people to be able to log in (recommended for a
friend group), set `ALLOWED_DISCORD_IDS` to a comma-separated list of their
Discord user IDs. Leave it blank to let anyone with a Discord account in.

## 3. Run it

```bash
npm install
npm start
```

Visit `http://localhost:3000`, click **Continue with Discord**, and you
should land back in the app logged in.

## 4. Put it somewhere with a real address

Discord needs to redirect back to a URL it can reach, so this has to live
somewhere with a stable address (`localhost` only works while you're testing
on your own machine). A few straightforward options, roughly easiest first:

- **Railway, Render, or Fly.io**: connect this folder as a repo, set the same
  environment variables from `.env` in their dashboard, and deploy. All three
  give you a free HTTPS domain out of the box.
- **Docker / Portainer**: see the dedicated section below.
- **A VPS** (DigitalOcean, Linode, etc.): copy this folder over, run
  `npm install && npm start` behind a process manager like `pm2`, and put
  Caddy or nginx in front of it for HTTPS.

Whichever you choose, update `DISCORD_REDIRECT_URI` in your environment
variables and the redirect list in the Discord Developer Portal to match the
real domain, and set `NODE_ENV=production` so session cookies require HTTPS.

## 5. Running it in Docker / Portainer

The repo includes a `Dockerfile` and `docker-compose.yml`. The container runs
as a non-root user and writes notes to `/app/data`, which the compose file
maps to a named volume (`ledger_data`) so your notes survive container
restarts, updates, and recreation.

### Quick local test with Docker

```bash
cp .env.example .env   # fill in real values first
docker compose up --build
```

Visit `http://localhost:3000` (or whatever `HOST_PORT` you set) and confirm
login works before moving on to Portainer.

### Deploying in Portainer

Portainer needs access to the `Dockerfile` to build the image, so the
cleanest path is pointing it at a git repo rather than pasting the compose
file directly:

1. Push this folder to a Git repo (GitHub, GitLab, a self-hosted Gitea, etc).
   Make sure `.env` is **not** committed — `.gitignore` already excludes it.
2. In Portainer: **Stacks > Add stack > Repository**.
3. Enter the repo URL and branch. Portainer will pull `docker-compose.yml`
   and build the image from the `Dockerfile` automatically.
4. Under **Environment variables**, add:
   - `DISCORD_CLIENT_ID`
   - `DISCORD_CLIENT_SECRET`
   - `DISCORD_REDIRECT_URI` (must match what's registered in Discord, e.g.
     `https://notes.yourdomain.com/auth/discord/callback`)
   - `SESSION_SECRET`
   - `ALLOWED_DISCORD_IDS` (optional)
   - `HOST_PORT` (optional, defaults to 3000)
5. Deploy the stack.

If you'd rather not use a git repo, build and push the image yourself instead,
then paste the compose file into Portainer's web editor with `build: .`
replaced by the image you pushed:

```bash
docker build -t yourname/ledger-discord:latest .
docker push yourname/ledger-discord:latest
```

Then in `docker-compose.yml`, drop the `build: .` line and set
`image: yourname/ledger-discord:latest`. Paste that into **Stacks > Add stack
> Web editor**, add the same environment variables there, and deploy.

### Reverse proxy and HTTPS

Discord login cookies are marked `secure` in production, so the app needs to
be served over HTTPS. If you're running something like Nginx Proxy Manager,
Caddy, or Traefik in front of your Portainer containers already, just point
it at this container's port and let it handle TLS — no changes needed here
beyond `NODE_ENV=production`, which the compose file already sets.

### Backing up notes

Notes live in the `ledger_data` volume as a single `db.json` file. To copy it
out for a backup:

```bash
docker cp ledger:/app/data/db.json ./db-backup.json
```

## How it's organized

- `server.js` — Express app: the Discord login flow and the notes API
- `store.js` — reads and writes `data/db.json`; swap this out later for a real
  database if the group outgrows a JSON file
- `public/index.html` — the whole frontend, talks to the API with `fetch`
- `Dockerfile`, `docker-compose.yml` — for running this in Docker or Portainer

## Notes on scale and durability

A JSON file is plenty for a handful of people jotting notes. If this grows
into something more serious, the only file that needs to change is
`store.js`; the API and frontend don't care where the data actually lives.
Back up `data/db.json` periodically if the notes matter to you, since there's
no replication or automatic backup built in.
