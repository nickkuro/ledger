# Ledger

**A private, Discord-backed notes app for characters, stories, and worldbuilding.**

Ledger started as a simple note-taking tool and has grown into a small self-hosted app with character organization, markdown notes, a calendar, reminders, a personal bill scheduler, and Discord integrations — all backed by your own Discord login.

<p>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-6DA55F?logo=node.js&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/backend-Express-000000?logo=express&logoColor=white">
  <img alt="Discord OAuth2" src="https://img.shields.io/badge/auth-Discord%20OAuth2-5865F2?logo=discord&logoColor=white">
  <img alt="Docker ready" src="https://img.shields.io/badge/deploy-Docker%20%2F%20Portainer-2496ED?logo=docker&logoColor=white">
  <img alt="Status" src="https://img.shields.io/badge/status-actively%20developed-e8a33d">
</p>

Each user signs in with Discord and gets their own private notes space. Data lives on the server, not the browser — this is intentionally a personal, self-hosted tool rather than a multi-tenant SaaS product.

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Deployment](#deployment)
- [Docker / Portainer](#docker--portainer)
- [Project structure](#project-structure)
- [Data storage](#data-storage)

---

## Features

**Notes**
- Plain text or Markdown notes with auto-save and live rendering
- Character-based organization with colored character groups
- Sticky notes that stay pinned across every character view
- Tags, full-text search, and filtered note views
- Inline image embedding

**Calendar**
- Month and week views of due notes, reminders, and bills
- Click a day to see everything scheduled for it
- Create a note directly from a calendar day, due date pre-filled

**Bills** *(admin, plus anyone granted access)*
- Each person with Bills access has their own private bill list — nobody sees anyone else's
- Track recurring bills — due date, frequency, category, currency
- Mark paid/unpaid; recurring bills auto-advance to their next due date
- Bill reminders sent to Discord DMs, same as note reminders
- Overview dashboard (overdue/upcoming/paid, total due) shown when no bill is selected

**Discord integration**
- Discord OAuth2 login, with an optional allow-list of approved user IDs
- Admin-only "Manage access" panel to add or remove allowed Discord accounts, and grant/revoke individual Bills access, all from the UI with no redeploy needed
- Send any note straight to your own Discord DMs
- One-time or repeating reminders delivered via DM
- Per-user timezone support for accurate reminder times

**Look & feel**
- Dark/light theme
- In-app About + versioned Changelog
- Terms of Service and Privacy Policy pages

For the full version history, open the **About → Changelog** tab inside the app.

---

## Quick start

### 1. Register a Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Open **OAuth2** in the sidebar and note the Client ID and Client Secret.
3. Under **Redirects**, add:
   - Local: `http://localhost:3000/auth/discord/callback`
   - Production: `https://your-domain.com/auth/discord/callback`

### 2. Configure the app

```bash
cp .env.example .env
```

Fill in the required values:

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_CLIENT_ID` | Yes | From the Discord Developer Portal |
| `DISCORD_CLIENT_SECRET` | Yes | From the Discord Developer Portal |
| `DISCORD_REDIRECT_URI` | Yes | Must exactly match a registered redirect |
| `SESSION_SECRET` | Yes | Random string used to sign session cookies |
| `ALLOWED_DISCORD_IDS` | No | Comma-separated baseline guest list of approved Discord user IDs — day-to-day changes are easier via the in-app "Manage access" admin panel |
| `BOT_TOKEN` | No | Enables Send-to-DM and reminder features |
| `ADMIN_DISCORD_ID` | No | Discord ID with site-admin access — Manage Access panel, and their own Bills tab by default |
| `PORT` | No | Custom port (defaults to 3000) |

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Install and run

```bash
npm install
npm start
```

Then visit `http://localhost:3000` and sign in with Discord.

---

## Deployment

Discord login needs a real HTTPS callback URL, so the app should be deployed somewhere with a stable domain. Good options include:

- Railway, Render, or Fly.io
- Docker / Portainer
- A VPS with nginx or Caddy

In production, make sure:

- `DISCORD_REDIRECT_URI` matches the deployed domain
- `NODE_ENV=production` is set
- the app is served over HTTPS

---

## Docker / Portainer

The repo includes a `Dockerfile` and `docker-compose.yml` for containerized deployment.

**Local Docker run:**

```bash
cp .env.example .env
docker compose up --build
```

**Portainer:**

1. Push the repo to GitHub or another Git host.
2. In Portainer, create a stack from the repository.
3. Add the same environment variables from `.env`.
4. Deploy the stack.

The container uses a persistent data volume so notes, sessions, and bills survive container restarts and recreation.

---

## Project structure

```
.
├── server.js         Express server, Discord OAuth flow, and API routes
├── store.js          Data layer — notes, characters, reminders, bills, users
├── store-check.js    Lightweight smoke test for the data layer
├── public/
│   ├── index.html      Frontend UI — notes, calendar, bills, and modals
│   ├── terms.html       Terms of Service
│   └── privacy.html     Privacy Policy
├── Dockerfile
└── docker-compose.yml
```

---

## Data storage

Ledger stores data in a JSON file on the server rather than a database. That's simple, easy to back up, and practical for a project at this scale. If it ever needs to grow past that, the data layer in `store.js` is isolated enough to swap out without touching the rest of the app.

---

<sub>Built and maintained by Awucard.</sub>
