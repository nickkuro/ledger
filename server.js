// server.js
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");
const store = require("./store");

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  SESSION_SECRET,
  ALLOWED_DISCORD_IDS,
  PORT
} = process.env;

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI || !SESSION_SECRET) {
  console.error("Missing required env vars. Copy .env.example to .env and fill in all four required values.");
  process.exit(1);
}

const allowlist = (ALLOWED_DISCORD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  next();
}

// ---------- Discord OAuth2 ----------
app.get("/auth/discord", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state,
    prompt: "consent"
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send("Login failed: invalid or expired state. Go back and try again.");
  }
  delete req.session.oauthState;
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      })
    });
    if (!tokenRes.ok) throw new Error("Token exchange failed: " + (await tokenRes.text()));
    const tokenData = await tokenRes.json();
    const profileRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!profileRes.ok) throw new Error("Could not fetch Discord profile");
    const profile = await profileRes.json();
    if (allowlist.length && !allowlist.includes(profile.id)) {
      return res.status(403).send("Your Discord account isn't on the guest list for this Ledger.");
    }
    const user = await store.upsertUser(profile);
    req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).send("Login failed. Check the server logs.");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  res.json(req.session.user);
});

// ---------- Characters API ----------
app.get("/api/characters", requireAuth, (req, res) => {
  res.json(store.listCharacters(req.session.user.id));
});

app.post("/api/characters", requireAuth, async (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
  const character = await store.createCharacter(req.session.user.id, { name: name.trim(), color });
  res.status(201).json(character);
});

app.put("/api/characters/:id", requireAuth, async (req, res) => {
  const character = await store.updateCharacter(req.session.user.id, req.params.id, req.body || {});
  if (!character) return res.status(404).json({ error: "Not found" });
  res.json(character);
});

app.delete("/api/characters/:id", requireAuth, async (req, res) => {
  const ok = await store.deleteCharacter(req.session.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ---------- Notes API ----------
app.get("/api/notes", requireAuth, (req, res) => {
  const characterId = req.query.characterId || "__all__";
  res.json(store.listNotes(req.session.user.id, characterId));
});

app.post("/api/notes", requireAuth, async (req, res) => {
  const note = await store.createNote(req.session.user.id, req.body || {});
  res.status(201).json(note);
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

app.delete("/api/notes", requireAuth, async (req, res) => {
  const characterId = req.query.characterId || "__all__";
  await store.clearNotes(req.session.user.id, characterId);
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("ok"));
app.use(express.static(path.join(__dirname, "public")));

const port = PORT || 3000;
app.listen(port, () => console.log(`Ledger running on http://localhost:${port}`));
