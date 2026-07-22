# Ledger

**A private, Discord-backed notes app for characters, stories, and worldbuilding.**

Ledger started as a simple note-taking tool and has grown into a small self-hosted app with character organization, markdown notes, a calendar, reminders, a personal bill scheduler, and Discord integrations, all backed by your own Discord login.

<p>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-6DA55F?logo=node.js&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/backend-Express-000000?logo=express&logoColor=white">
  <img alt="Discord OAuth2" src="https://img.shields.io/badge/auth-Discord%20OAuth2-5865F2?logo=discord&logoColor=white">
  <img alt="Docker ready" src="https://img.shields.io/badge/deploy-Docker%20%2F%20Portainer-2496ED?logo=docker&logoColor=white">
  <img alt="Status" src="https://img.shields.io/badge/status-actively%20developed-e8a33d">
</p>

Each user signs in with Discord and gets their own private notes space. Data lives on the server, not the browser; this is intentionally a personal, self-hosted tool rather than a multi-tenant SaaS product.

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
- Spoiler notes: blur a note's card in the list until you open it, for plot twists and anything you don't want to see at a glance
- Tags, full-text search, and filtered note views
- Inline image embedding
- One-step "previous version" safety net: restore a note's content from right before the last save if an accidental paste-over gets autosaved

**Calendar**
- Month and week views of due notes, reminders, and bills
- Click a day to see everything scheduled for it
- Create a note directly from a calendar day, due date pre-filled

**Bills** *(admin, plus anyone granted access)*
- Each person with Bills access has their own private bill list; nobody sees anyone else's
- Track recurring bills: due date, frequency, category, currency, and a Low/Medium/High/Urgent priority (which also sets the bill's colour)
- Mark paid/unpaid; recurring bills auto-advance to their next due date
- Bill reminders sent to Discord DMs, same as note reminders
- Overview dashboard (overdue/upcoming/paid, outstanding bills) shown when no bill is selected, with same-day bills sorted by priority
- 12-month bill forecast: a real month-by-month projection of what's actually due, plus a yearly total, based on each bill's actual future due dates
- "How is this calculated?" breakdown showing exactly which bills (and how many times each) make up the totals
- Spend-by-category breakdown and a payment history section based on what's actually been paid
- Estimated monthly income input on the dashboard, with a live left-over/short-by comparison against what's due this month
- Per-user default currency (Settings → Account) pre-fills new bills and the income estimate instead of always defaulting to USD; changing it can also relabel your existing bills to match
- Customizable bill categories (Settings → Account): add or remove categories instead of being stuck with a fixed list

**Budget** *(same access as Bills)*
- Monthly envelope budgeting built on the categories you already use for bills
- "Start from your bills" seeds targets for every category that has bills, spreading yearly/quarterly costs across the months instead of charging them in one lump
- Bills you've paid count toward their category automatically, so only variable spending gets logged by hand
- Rollover: underspend carries into next month, overspend carries as a shortfall
- Targets are versioned by month, so changing this month's budget never rewrites past months
- Per-category bars split what came from bills vs. what you logged, and a month picker to review previous months

**Discord integration**
- Discord OAuth2 login, with an optional allow-list of approved user IDs
- Admin-only "Manage access" panel to add or remove allowed Discord accounts, and grant/revoke individual Bills access, all from the UI with no redeploy needed
- Send any note straight to your own Discord DMs
- One-time or repeating reminders delivered via DM
- Opt-in daily/weekly/monthly digest DM summarizing overdue bills, bills due soon, and upcoming reminders in one message, only sent when there's something to report
- Per-user timezone support for accurate reminder times

**Local accounts** *(for people without Discord)*
- Admin creates a username/password account from Manage access, no Discord required
- New accounts (and admin-reset passwords) must be changed on first login; users can change their own password anytime from Settings
- Passwords are hashed with Node's built-in `crypto.scrypt`, no new dependency
- Discord-only features (Send to DMs, reminders, the digest DM) are hidden for local accounts, since there's no Discord identity to deliver them to
- Manage access shows each local account's last login time, so admins can tell whether an invite has actually been used
- Removing a local account also deletes everything it owns (notes, characters, reminders, bills)

**Your data**
- Import: load an export file back in from Settings. Strictly additive (nothing is overwritten), with anything resembling a duplicate listed up front for you to skip or keep. Reminders are not imported
- Recently deleted: deleted notes and bills are recoverable for 30 days from Settings, then purged automatically. You can also delete for good or empty the trash yourself
- Export: download all your notes, characters, reminders, and bills as a single JSON file, any time, from the settings menu
- Remove: permanently delete everything on your account (notes, characters, reminders, bills) yourself, with a confirmation step, no need to ask an admin
- Calendar feed: a personal `.ics` link (works for Discord and local accounts alike) to subscribe to your bill and note due dates from Google/Apple Calendar; regenerate it anytime to invalidate an old link
- Installable as a mobile app (Add to Home Screen on Android or iOS Safari) via a web app manifest and service worker

**Look & feel**
- Dark/light theme
- First-visit onboarding tour over the login screen (shown once, dismissible, remembered per browser)
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
| `ALLOWED_DISCORD_IDS` | No | Comma-separated baseline guest list of approved Discord user IDs; day-to-day changes are easier via the in-app "Manage access" admin panel |
| `BOT_TOKEN` | No | Enables Send-to-DM and reminder features |
| `ADMIN_DISCORD_ID` | No | Discord ID with site-admin access: Manage Access panel, and their own Bills tab by default |
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
├── store.js          Data layer: notes, characters, reminders, bills, users
├── store-check.js    Smoke test for the data layer
├── server-check.js   Route tests for auth guards and cross-user isolation
├── public/
│   ├── index.html      Page shell, styles, and About/changelog markup
│   ├── app.js          Frontend app logic (notes, calendar, bills, modals)
│   ├── vendor/         Self-hosted marked + DOMPurify
│   ├── terms.html       Terms of Service
│   └── privacy.html     Privacy Policy
├── Dockerfile
└── docker-compose.yml
```

Tests run with `npm test` (data-layer smoke test plus the route tests). The
route tests boot the app on an ephemeral port against a throwaway
`LEDGER_DATA_DIR`, so they never touch your real database.

---

## Data storage

Ledger stores data in a SQLite database (`data/ledger.sqlite3`), still just a single file in the same data volume, with no separate database service to run or back up.

Older deployments used a single `data/db.json` file instead. If Ledger finds one on startup, it migrates it into SQLite automatically, verifies the row counts match, and renames the original to `data/db.json.migrated-<timestamp>.bak` (never deletes it). If anything about the migration looks wrong, the server refuses to start rather than run on partial data, and the original `db.json` is left completely untouched.

---

<sub>Built and maintained by Awucard.</sub>
