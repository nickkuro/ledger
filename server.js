// server.js
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const path = require("path");
const store = require("./store");

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
  SESSION_SECRET, ALLOWED_DISCORD_IDS, BOT_TOKEN, ADMIN_DISCORD_ID, PORT
} = process.env;

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI || !SESSION_SECRET) {
  console.error("Missing required env vars.");
  process.exit(1);
}

const envAllowlist = (ALLOWED_DISCORD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

function isAllowedDiscordId(id) {
  if (id === ADMIN_DISCORD_ID) return true;
  const dynamicIds = store.listAllowlist().map((e) => e.id);
  const effective = envAllowlist.concat(dynamicIds);
  return !effective.length || effective.includes(id);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(session({
  store: new FileStore({
    path: path.join(__dirname, "data", "sessions"),
    ttl: 60 * 60 * 24 * 30,
    retries: 1,
    logFn: function() {}
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

function renderErrorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — Ledger</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>
  :root { --bg:#14181c; --surface:#1b2126; --border:#2b333a; --ink:#ece8e1; --ink-mid:#a8b4be; --accent:#e8a33d; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: 'IBM Plex Sans', sans-serif; background: var(--bg); color: var(--ink);
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    text-align: center; padding: 44px 40px; border: 1px solid var(--border);
    border-radius: 10px; background: var(--surface); max-width: 360px; width: 90%;
  }
  .mark { font-size: 32px; color: var(--accent); font-family: 'IBM Plex Mono', monospace; display: block; margin-bottom: 8px; }
  h1 { font-family: 'IBM Plex Mono', monospace; letter-spacing: 0.1em; font-size: 17px; margin: 0 0 12px; }
  p { color: var(--ink-mid); font-size: 13.5px; line-height: 1.6; margin: 0 0 26px; }
  a.back {
    display: inline-block; background: var(--accent); color: #1b130a;
    padding: 11px 20px; border-radius: 7px; font-weight: 600; font-size: 14px; text-decoration: none;
  }
  a.back:hover { filter: brightness(1.08); }
</style>
</head>
<body>
  <div class="card">
    <span class="mark">¶</span>
    <h1>${title}</h1>
    <p>${message}</p>
    <a class="back" href="/">Back to Ledger</a>
  </div>
</body>
</html>`;
}

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).send(renderErrorPage(
      "Slow down",
      "Too many login attempts from here. Give it a minute, then try signing in again."
    ));
  }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Key by logged-in user when possible, so people sharing an IP/network
  // (e.g. two housemates both using Bills) don't throttle each other.
  keyGenerator: (req) => (req.session && req.session.user) ? `user:${req.session.user.id}` : req.ip,
  message: { error: "Too many requests. Slow down and try again in a minute." }
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  if (!ADMIN_DISCORD_ID || req.session.user.id !== ADMIN_DISCORD_ID) {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

function requireBillsAccess(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  const id = req.session.user.id;
  if (id === ADMIN_DISCORD_ID || store.hasBillsAccess(id)) return next();
  return res.status(403).json({ error: "You don't have access to Bills" });
}

// ---------- Discord bot helpers ----------
const DISCORD_API = "https://discord.com/api/v10";

async function botFetch(path, opts = {}) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN not configured");
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...opts,
    headers: { "Authorization": `Bot ${BOT_TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord API error ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

async function getDMChannel(discordUserId) {
  return botFetch("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: discordUserId })
  });
}

function splitMessage(text, max = 1900) {
  if (text.length <= max) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > max) {
    let split = remaining.lastIndexOf("\n", max);
    if (split < max / 2) split = max;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).replace(/^\n+/, "");
  }
  if (remaining.trim()) chunks.push(remaining);
  return chunks;
}

function getAppUrl() {
  return "https://notes.awucard.me";
}

function buildReminderBlurb(note) {
  const title = note.title?.trim() || "Untitled note";
  const body = (note.body || "").replace(/\s+/g, " ").trim();
  const blurb = body
    ? body.length > 180
      ? `${body.slice(0, 180)}...\n\n[See more on Ledger]`
      : body
    : "No note body yet.";
  return `Hey, wake up. You asked me to remind you about this note.\n\n**${title}**\n\n${blurb}`;
}

async function sendDM(discordUserId, content, options = {}) {
  const channel = await getDMChannel(discordUserId);
  const chunks = splitMessage(content, options.maxLength || 3800);
  const label = options.label || "Ledger";
  for (const chunk of chunks) {
    const payload = {
      content: "",
      embeds: [{
        title: label,
        description: chunk,
        color: 0xE8A33D,
        footer: { text: "Sent from Ledger" }
      }]
    };
    if (options.buttonUrl) {
      payload.components = [{
        type: 1,
        components: [{
          type: 2,
          style: 5,
          label: options.buttonLabel || "Head to Ledger",
          url: options.buttonUrl
        }]
      }];
    }
    await botFetch(`/channels/${channel.id}/messages`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }
}

function formatNoteForDiscord(note, label = null) {
  let msg = label ? `${label}\n` : "";
  if (note.title) msg += `**${note.title}**\n`;
  if (note.body) msg += `\n${note.body}`;
  if (note.tags && note.tags.length) msg += `\n\n🏷️ ${note.tags.map((t) => `#${t}`).join(" ")}`;
  return msg.trim();
}

// ---------- Reminder job ----------
function startReminderJob() {
  setInterval(async () => {
    const due = store.getDueReminders();
    for (const reminder of due) {
      try {
        const user = store.getUser(reminder.ownerId);
        const note = store.getNote(reminder.ownerId, reminder.noteId);
        const title = note ? note.title : reminder.noteTitle;
        const body = note ? note.body : "(Note no longer exists)";
        const tags = note ? note.tags : [];
        const fakeNote = { title, body, tags };
        const content = buildReminderBlurb(fakeNote);
        if (user) await sendDM(user.id, content, {
          label: "Hey, wake up",
          buttonUrl: getAppUrl()
        });
      } catch (err) {
        console.error("Reminder DM failed:", err.message);
      }
      if (reminder.repeat && reminder.repeatInterval) {
        await store.rescheduleReminder(reminder.id, reminder.repeatInterval);
      } else {
        await store.deleteReminder(reminder.ownerId, reminder.id);
      }
    }
  }, 30000);
}

// ---------- Bill due-date reminder job ----------
function dateToStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function startBillReminderJob() {
  setInterval(async () => {
    const todayStr = dateToStr(new Date());
    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
    for (const bill of store.getAllBills()) {
      if (bill.paid || !bill.dueDate || bill.reminderDays == null) continue;
      if (bill.lastReminderSent === todayStr) continue;
      const due = new Date(bill.dueDate + "T00:00:00");
      const daysUntilDue = Math.round((due - todayMidnight) / 86400000);
      if (daysUntilDue !== Number(bill.reminderDays)) continue;
      try {
        const dayWord = daysUntilDue === 1 ? "day" : "days";
        await sendDM(
          bill.ownerId,
          `💳 **${bill.name}** is due in ${daysUntilDue} ${dayWord} (${bill.dueDate}) — ${bill.currency} $${Number(bill.amount).toFixed(2)}`,
          { label: "Bill reminder", buttonUrl: getAppUrl(), buttonLabel: "View in Ledger" }
        );
      } catch (err) {
        console.error("Bill reminder DM failed:", err.message);
      }
      await store.markBillReminderSent(bill.id, todayStr);
    }
  }, 15 * 60 * 1000);
}

// ---------- Discord OAuth2 ----------
app.get("/auth/discord", authLimiter, (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code", scope: "identify", state, prompt: "consent"
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", authLimiter, async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send("Login failed: invalid or expired state. Go back and try again.");
  }
  delete req.session.oauthState;
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: DISCORD_REDIRECT_URI })
    });
    if (!tokenRes.ok) throw new Error("Token exchange failed");
    const tokenData = await tokenRes.json();
    const profileRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    if (!profileRes.ok) throw new Error("Could not fetch Discord profile");
    const profile = await profileRes.json();
    if (!isAllowedDiscordId(profile.id)) {
      return res.status(403).send("Your Discord account isn't on the guest list for this Ledger.");
    }
    const user = await store.upsertUser(profile);
    req.session.user = {
      id: user.id, username: user.username, avatar: user.avatar, timezone: user.timezone || "UTC",
      incomeEstimate: user.incomeEstimate != null ? user.incomeEstimate : null,
      incomeCurrency: user.incomeCurrency || "USD",
      authType: "discord", mustChangePassword: false
    };
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).send("Login failed. Check the server logs.");
  }
});

app.post("/auth/local-login", authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password are required." });
  const user = store.verifyLocalLogin(username, password);
  if (!user) return res.status(401).json({ error: "Invalid username or password." });
  req.session.user = {
    id: user.id, username: user.username, avatar: null, timezone: user.timezone || "UTC",
    incomeEstimate: user.incomeEstimate != null ? user.incomeEstimate : null,
    incomeCurrency: user.incomeCurrency || "USD",
    authType: "local", mustChangePassword: user.mustChangePassword
  };
  res.json({ ok: true });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  const isAdmin = req.session.user.id === ADMIN_DISCORD_ID;
  const canAccessBills = isAdmin || store.hasBillsAccess(req.session.user.id);
  res.json({ ...req.session.user, isAdmin, canAccessBills });
});

app.put("/api/me/timezone", requireAuth, async (req, res) => {
  const { timezone } = req.body || {};
  if (!timezone) return res.status(400).json({ error: "timezone required" });
  const user = await store.updateUserTimezone(req.session.user.id, timezone);
  req.session.user.timezone = timezone;
  res.json(user);
});

app.put("/api/me/income", requireAuth, async (req, res) => {
  const { amount, currency } = req.body || {};
  const parsed = amount === null || amount === "" || amount === undefined ? null : Number(amount);
  if (parsed != null && !Number.isFinite(parsed)) {
    return res.status(400).json({ error: "amount must be a number" });
  }
  const user = await store.updateUserIncome(req.session.user.id, parsed, currency);
  req.session.user.incomeEstimate = user.incomeEstimate;
  req.session.user.incomeCurrency = user.incomeCurrency;
  res.json(user);
});

app.get("/api/me/export", requireAuth, (req, res) => {
  const id = req.session.user.id;
  const canAccessBills = id === ADMIN_DISCORD_ID || store.hasBillsAccess(id);
  const data = {
    exportedAt: new Date().toISOString(),
    user: { id, username: req.session.user.username },
    characters: store.listCharacters(id),
    notes: store.listNotes(id, "__all__"),
    reminders: store.listReminders(id),
    bills: canAccessBills ? store.listBills(id) : []
  };
  res.setHeader("Content-Disposition", `attachment; filename="ledger-export-${id}.json"`);
  res.json(data);
});

app.post("/api/me/delete-data", requireAuth, async (req, res) => {
  await store.deleteAllUserData(req.session.user.id);
  req.session.destroy(() => res.json({ ok: true }));
});

app.put("/api/me/password", requireAuth, async (req, res) => {
  if (req.session.user.authType !== "local") {
    return res.status(400).json({ error: "Discord accounts don't have a Ledger password." });
  }
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  const ok = await store.changeOwnPassword(req.session.user.id, currentPassword || "", newPassword);
  if (!ok) return res.status(400).json({ error: "Current password is incorrect." });
  req.session.user.mustChangePassword = false;
  res.json({ ok: true });
});

app.use("/api", apiLimiter);

// ---------- Characters ----------
app.get("/api/characters", requireAuth, (req, res) => res.json(store.listCharacters(req.session.user.id)));
app.post("/api/characters", requireAuth, async (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
  res.status(201).json(await store.createCharacter(req.session.user.id, { name: name.trim(), color }));
});
app.put("/api/characters/:id", requireAuth, async (req, res) => {
  const c = await store.updateCharacter(req.session.user.id, req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: "Not found" });
  res.json(c);
});
app.delete("/api/characters/:id", requireAuth, async (req, res) => {
  const ok = await store.deleteCharacter(req.session.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- Notes ----------
app.get("/api/notes", requireAuth, (req, res) => {
  res.json(store.listNotes(req.session.user.id, req.query.characterId || "__all__"));
});
app.post("/api/notes", requireAuth, async (req, res) => {
  res.status(201).json(await store.createNote(req.session.user.id, req.body || {}));
});
app.put("/api/notes/:id", requireAuth, async (req, res) => {
  const note = await store.updateNote(req.session.user.id, req.params.id, req.body || {});
  if (!note) return res.status(404).json({ error: "Not found" });
  res.json(note);
});
app.delete("/api/notes/:id", requireAuth, async (req, res) => {
  const ok = await store.deleteNote(req.session.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});
app.post("/api/notes/:id/restore-previous", requireAuth, async (req, res) => {
  const note = await store.restorePreviousVersion(req.session.user.id, req.params.id);
  if (!note) return res.status(404).json({ error: "No previous version to restore" });
  res.json(note);
});
app.delete("/api/notes", requireAuth, async (req, res) => {
  await store.clearNotes(req.session.user.id, req.query.characterId || "__all__");
  res.json({ ok: true });
});

// ---------- Send note to DM ----------
app.post("/api/notes/:id/send-dm", requireAuth, async (req, res) => {
  if (!BOT_TOKEN) return res.status(503).json({ error: "Bot not configured — add BOT_TOKEN to your environment variables." });
  const note = store.getNote(req.session.user.id, req.params.id);
  if (!note) return res.status(404).json({ error: "Not found" });
  try {
    await sendDM(req.session.user.id, formatNoteForDiscord(note), { label: "Note from Ledger" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Send DM failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Reminders ----------
app.get("/api/reminders", requireAuth, (req, res) => {
  res.json(store.listReminders(req.session.user.id));
});
app.get("/api/notes/:id/reminders", requireAuth, (req, res) => {
  res.json(store.listRemindersForNote(req.session.user.id, req.params.id));
});
app.post("/api/reminders", requireAuth, async (req, res) => {
  if (!BOT_TOKEN) return res.status(503).json({ error: "Bot not configured — add BOT_TOKEN to your environment variables." });
  const { noteId, fireAt, repeat, repeatInterval, noteTitle } = req.body || {};
  if (!noteId || !fireAt) return res.status(400).json({ error: "noteId and fireAt required" });
  const reminder = await store.createReminder(req.session.user.id, { noteId, fireAt, repeat, repeatInterval, noteTitle });
  res.status(201).json(reminder);
});
app.delete("/api/reminders/:id", requireAuth, async (req, res) => {
  const ok = await store.deleteReminder(req.session.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- Bills (per-user, gated by bills access) ----------
app.get("/api/bills", requireBillsAccess, (req, res) => res.json(store.listBills(req.session.user.id)));

app.post("/api/bills", requireBillsAccess, async (req, res) => {
  const bill = await store.createBill(req.session.user.id, req.body || {});
  res.status(201).json(bill);
});

app.put("/api/bills/:id", requireBillsAccess, async (req, res) => {
  const bill = await store.updateBill(req.session.user.id, req.params.id, req.body || {});
  if (!bill) return res.status(404).json({ error: "Not found" });
  res.json(bill);
});

app.post("/api/bills/:id/pay", requireBillsAccess, async (req, res) => {
  const bill = await store.markBillPaid(req.session.user.id, req.params.id);
  if (!bill) return res.status(404).json({ error: "Not found" });
  if (BOT_TOKEN) {
    sendDM(req.session.user.id, `✅ **${bill.name}** marked as paid. Next due: ${bill.dueDate || "—"}`, { label: "Bill paid" })
      .catch(e => console.error("Bill paid DM:", e.message));
  }
  res.json(bill);
});

app.post("/api/bills/:id/unpay", requireBillsAccess, async (req, res) => {
  const bill = await store.markBillUnpaid(req.session.user.id, req.params.id);
  if (!bill) return res.status(404).json({ error: "Not found" });
  res.json(bill);
});

app.post("/api/bills/:id/send-dm", requireBillsAccess, async (req, res) => {
  if (!BOT_TOKEN) return res.status(503).json({ error: "Bot not configured" });
  const bill = store.getBill(req.session.user.id, req.params.id);
  if (!bill) return res.status(404).json({ error: "Not found" });
  const today = dateToStr(new Date());
  const isOverdue = bill.dueDate && bill.dueDate < today && !bill.paid;
  const status = bill.paid ? "✅ Paid" : isOverdue ? "⚠️ Overdue" : "Upcoming";
  const msg = `💳 **${bill.name}**\n\n**Amount:** ${bill.currency} $${Number(bill.amount).toFixed(2)}\n**Due:** ${bill.dueDate || "—"}\n**Status:** ${status}\n**Frequency:** ${bill.frequency}\n**Category:** ${bill.category}${bill.notes ? `\n**Notes:** ${bill.notes}` : ""}`;
  try {
    await sendDM(req.session.user.id, msg, { label: "Bill from Ledger", buttonUrl: getAppUrl(), buttonLabel: "View in Ledger" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/bills/:id", requireBillsAccess, async (req, res) => {
  const ok = await store.deleteBill(req.session.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- Access allowlist (admin only) ----------
async function resolveDiscordUsername(id) {
  const cached = store.getUser(id);
  if (cached && cached.username) return cached.username;
  if (!BOT_TOKEN) return null;
  try {
    const user = await botFetch(`/users/${id}`);
    return (user && (user.global_name || user.username)) || null;
  } catch (err) {
    return null;
  }
}

app.get("/api/admin/allowlist", requireAdmin, async (req, res) => {
  const seen = new Set();
  const result = [];
  if (ADMIN_DISCORD_ID) {
    result.push({ id: ADMIN_DISCORD_ID, label: "You (admin)", source: "admin" });
    seen.add(ADMIN_DISCORD_ID);
  }
  store.listAllowlist().forEach((e) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    result.push({ id: e.id, label: e.label, source: "dynamic", addedAt: e.addedAt });
  });
  envAllowlist.forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    result.push({ id, label: "", source: "env" });
  });
  await Promise.all(result.map(async (entry) => {
    entry.username = await resolveDiscordUsername(entry.id);
    entry.billsAccess = entry.source === "admin" || store.hasBillsAccess(entry.id);
  }));
  res.json(result);
});

app.post("/api/admin/allowlist", requireAdmin, async (req, res) => {
  const { id, label } = req.body || {};
  const trimmed = String(id || "").trim();
  if (!/^\d{15,20}$/.test(trimmed)) {
    return res.status(400).json({ error: "Enter a valid Discord user ID (numbers only)." });
  }
  const entry = await store.addAllowlistEntry(trimmed, label);
  res.status(201).json(entry);
});

app.delete("/api/admin/allowlist/:id", requireAdmin, async (req, res) => {
  const ok = await store.removeAllowlistEntry(req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- Local (non-Discord) accounts (admin only) ----------
const LOCAL_USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

app.get("/api/admin/local-accounts", requireAdmin, (req, res) => {
  const result = store.listLocalAccounts().map((u) => ({
    id: u.id, username: u.username, createdAt: u.updatedAt,
    mustChangePassword: u.mustChangePassword, billsAccess: store.hasBillsAccess(u.id)
  }));
  res.json(result);
});

app.post("/api/admin/local-accounts", requireAdmin, async (req, res) => {
  const { username, password } = req.body || {};
  const trimmed = String(username || "").trim();
  if (!LOCAL_USERNAME_RE.test(trimmed)) {
    return res.status(400).json({ error: "Username must be 3-32 characters (letters, numbers, _ . -)." });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  try {
    const account = await store.createLocalAccount(trimmed, password);
    res.status(201).json({ id: account.id, username: account.username, mustChangePassword: account.mustChangePassword });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.put("/api/admin/local-accounts/:id/password", requireAdmin, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const account = await store.adminResetPassword(req.params.id, newPassword);
  if (!account) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

app.delete("/api/admin/local-accounts/:id", requireAdmin, async (req, res) => {
  const ok = await store.deleteLocalAccount(req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- Bills access grants (admin only) ----------
app.post("/api/admin/bills-access", requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  const trimmed = String(id || "").trim();
  if (!/^\d{15,20}$/.test(trimmed)) {
    return res.status(400).json({ error: "Enter a valid Discord user ID (numbers only)." });
  }
  const entry = await store.grantBillsAccess(trimmed);
  res.status(201).json(entry);
});

app.delete("/api/admin/bills-access/:id", requireAdmin, async (req, res) => {
  const ok = await store.revokeBillsAccess(req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("ok"));
app.use(express.static(path.join(__dirname, "public")));

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Ledger running on http://localhost:${port}`);
  if (BOT_TOKEN) {
    startReminderJob();
    startBillReminderJob();
    console.log("Reminder jobs started.");
  } else {
    console.log("No BOT_TOKEN — DM and reminder features disabled.");
  }
});
