// store.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

// Defaults to ./data; LEDGER_DATA_DIR lets tests (and anyone who wants to)
// point the database at a throwaway directory instead of the real one.
const DATA_DIR = process.env.LEDGER_DATA_DIR
  ? path.resolve(process.env.LEDGER_DATA_DIR)
  : path.join(__dirname, "data");
const SQLITE_FILE = path.join(DATA_DIR, "ledger.sqlite3");
const BUILDING_FILE = path.join(DATA_DIR, "ledger.sqlite3.building");
const LEGACY_JSON_FILE = path.join(DATA_DIR, "db.json");

const DEFAULT_BILL_CATEGORIES = ["Housing", "Utilities", "Entertainment", "Insurance", "Subscriptions", "Food", "Transport", "Health", "Savings", "Other"];
const BILL_PRIORITIES = ["low", "medium", "high", "urgent"];
const PRIORITY_COLORS = { low: "#4fa8a0", medium: "#7c8cc9", high: "#e8a33d", urgent: "#c9605a" };
const PRIORITY_ORDER = { urgent: 3, high: 2, medium: 1, low: 0 };

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT,
  avatar TEXT,
  timezone TEXT,
  incomeEstimate REAL,
  incomeCurrency TEXT,
  updatedAt INTEGER,
  passwordHash TEXT,
  authType TEXT DEFAULT 'discord',
  mustChangePassword INTEGER DEFAULT 0,
  icalToken TEXT,
  digestFrequency TEXT DEFAULT 'off',
  lastDigestSentAt INTEGER,
  lastLoginAt INTEGER,
  defaultCurrency TEXT DEFAULT 'USD',
  billCategories TEXT
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY NOT NULL,
  ownerId TEXT,
  name TEXT,
  color TEXT,
  createdAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_characters_owner ON characters(ownerId);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY NOT NULL,
  ownerId TEXT,
  characterId TEXT,
  title TEXT,
  body TEXT,
  tags TEXT,
  sticky INTEGER,
  spoiler INTEGER,
  dueDate TEXT,
  createdAt INTEGER,
  updatedAt INTEGER,
  deletedAt INTEGER,
  prevTitle TEXT,
  prevBody TEXT,
  prevSavedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(ownerId);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY NOT NULL,
  ownerId TEXT,
  noteId TEXT,
  noteTitle TEXT,
  fireAt INTEGER,
  repeat INTEGER,
  repeatInterval INTEGER,
  createdAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(ownerId);
CREATE INDEX IF NOT EXISTS idx_reminders_fireAt ON reminders(fireAt);

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY NOT NULL,
  ownerId TEXT,
  name TEXT,
  amount REAL,
  currency TEXT,
  dueDate TEXT,
  frequency TEXT,
  category TEXT,
  autoPay INTEGER,
  url TEXT,
  color TEXT,
  notes TEXT,
  reminderDays INTEGER,
  paid INTEGER,
  paidDates TEXT,
  lastReminderSent TEXT,
  createdAt INTEGER,
  deletedAt INTEGER,
  priority TEXT DEFAULT 'medium'
);
CREATE INDEX IF NOT EXISTS idx_bills_owner ON bills(ownerId);

CREATE TABLE IF NOT EXISTS allowlist (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT,
  addedAt INTEGER
);

CREATE TABLE IF NOT EXISTS billsAccess (
  id TEXT PRIMARY KEY NOT NULL,
  addedAt INTEGER
);
`;

let db = null;

function applyPragmas(handle) {
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA foreign_keys = OFF");
  handle.exec("PRAGMA synchronous = NORMAL");
}

// Adds columns introduced after a database was first created. SCHEMA_SQL's
// CREATE TABLE IF NOT EXISTS only applies to brand-new databases, so any
// database that already exists needs its own additive, idempotent path here.
// Never drops or rewrites existing columns/rows.
function ensureColumn(handle, table, column, type) {
  const cols = handle.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function ensureSchemaUpToDate(handle) {
  ensureColumn(handle, "notes", "spoiler", "INTEGER DEFAULT 0");
  // Soft delete: rows with a deletedAt sit in the trash until purged.
  ensureColumn(handle, "notes", "deletedAt", "INTEGER");
  ensureColumn(handle, "bills", "deletedAt", "INTEGER");
  ensureColumn(handle, "notes", "prevTitle", "TEXT");
  ensureColumn(handle, "notes", "prevBody", "TEXT");
  ensureColumn(handle, "notes", "prevSavedAt", "INTEGER");
  // Existing bills keep whatever color they already had -- only the
  // priority is backfilled (defaults every existing row to 'medium').
  // Color only gets recomputed from priority the next time it's changed.
  ensureColumn(handle, "bills", "priority", "TEXT DEFAULT 'medium'");
  // Existing (Discord) users backfill to authType='discord', passwordHash
  // stays NULL, mustChangePassword stays 0 -- none of that affects login.
  ensureColumn(handle, "users", "passwordHash", "TEXT");
  ensureColumn(handle, "users", "authType", "TEXT DEFAULT 'discord'");
  ensureColumn(handle, "users", "mustChangePassword", "INTEGER DEFAULT 0");
  ensureColumn(handle, "users", "icalToken", "TEXT");
  ensureColumn(handle, "users", "digestFrequency", "TEXT DEFAULT 'off'");
  ensureColumn(handle, "users", "lastDigestSentAt", "INTEGER");
  ensureColumn(handle, "users", "lastLoginAt", "INTEGER");
  ensureColumn(handle, "users", "defaultCurrency", "TEXT DEFAULT 'USD'");
  ensureColumn(handle, "users", "billCategories", "TEXT");
}

// Migrates a legacy data/db.json into the (already schema-created) handle.
// Throws on any error or row-count mismatch -- callers must not treat the
// handle as valid data if this throws.
function migrateFromJson(handle, jsonPath) {
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

  handle.exec("BEGIN");
  try {
    const insertUser = handle.prepare(
      `INSERT INTO users (id, username, avatar, timezone, incomeEstimate, incomeCurrency, updatedAt)
       VALUES (:id, :username, :avatar, :timezone, :incomeEstimate, :incomeCurrency, :updatedAt)`
    );
    Object.values(data.users || {}).forEach((u) => {
      insertUser.run({
        id: u.id,
        username: u.username ?? null,
        avatar: u.avatar ?? null,
        timezone: u.timezone ?? null,
        incomeEstimate: u.incomeEstimate != null ? Number(u.incomeEstimate) : null,
        incomeCurrency: u.incomeCurrency ?? null,
        updatedAt: u.updatedAt ?? null
      });
    });

    const insertCharacter = handle.prepare(
      `INSERT INTO characters (id, ownerId, name, color, createdAt)
       VALUES (:id, :ownerId, :name, :color, :createdAt)`
    );
    Object.values(data.characters || {}).forEach((c) => {
      insertCharacter.run({
        id: c.id,
        ownerId: c.ownerId ?? null,
        name: c.name ?? null,
        color: c.color ?? null,
        createdAt: c.createdAt ?? null
      });
    });

    const insertNote = handle.prepare(
      `INSERT INTO notes (id, ownerId, characterId, title, body, tags, sticky, dueDate, createdAt, updatedAt)
       VALUES (:id, :ownerId, :characterId, :title, :body, :tags, :sticky, :dueDate, :createdAt, :updatedAt)`
    );
    Object.values(data.notes || {}).forEach((n) => {
      insertNote.run({
        id: n.id,
        ownerId: n.ownerId ?? null,
        characterId: n.characterId ?? null,
        title: n.title ?? "",
        body: n.body ?? "",
        tags: JSON.stringify(Array.isArray(n.tags) ? n.tags : []),
        sticky: n.sticky ? 1 : 0,
        dueDate: n.dueDate ?? null,
        createdAt: n.createdAt ?? null,
        updatedAt: n.updatedAt ?? null
      });
    });

    const insertReminder = handle.prepare(
      `INSERT INTO reminders (id, ownerId, noteId, noteTitle, fireAt, repeat, repeatInterval, createdAt)
       VALUES (:id, :ownerId, :noteId, :noteTitle, :fireAt, :repeat, :repeatInterval, :createdAt)`
    );
    Object.values(data.reminders || {}).forEach((r) => {
      insertReminder.run({
        id: r.id,
        ownerId: r.ownerId ?? null,
        noteId: r.noteId ?? null,
        noteTitle: r.noteTitle ?? "",
        fireAt: r.fireAt ?? null,
        repeat: r.repeat ? 1 : 0,
        repeatInterval: r.repeatInterval ?? null,
        createdAt: r.createdAt ?? null
      });
    });

    const insertBill = handle.prepare(
      `INSERT INTO bills (id, ownerId, name, amount, currency, dueDate, frequency, category, autoPay, url, color, notes, reminderDays, paid, paidDates, lastReminderSent, createdAt)
       VALUES (:id, :ownerId, :name, :amount, :currency, :dueDate, :frequency, :category, :autoPay, :url, :color, :notes, :reminderDays, :paid, :paidDates, :lastReminderSent, :createdAt)`
    );
    Object.values(data.bills || {}).forEach((b) => {
      insertBill.run({
        id: b.id,
        ownerId: b.ownerId ?? null,
        name: b.name ?? "",
        amount: b.amount != null ? Number(b.amount) : 0,
        currency: b.currency ?? "USD",
        dueDate: b.dueDate ?? null,
        frequency: b.frequency ?? "monthly",
        category: b.category ?? "Other",
        autoPay: b.autoPay ? 1 : 0,
        url: b.url ?? "",
        color: b.color ?? "#c9605a",
        notes: b.notes ?? "",
        reminderDays: b.reminderDays != null ? Number(b.reminderDays) : null,
        paid: b.paid ? 1 : 0,
        paidDates: JSON.stringify(Array.isArray(b.paidDates) ? b.paidDates : []),
        lastReminderSent: b.lastReminderSent ?? null,
        createdAt: b.createdAt ?? null
      });
    });

    const insertAllowlist = handle.prepare(
      `INSERT INTO allowlist (id, label, addedAt) VALUES (:id, :label, :addedAt)`
    );
    Object.values(data.allowlist || {}).forEach((e) => {
      insertAllowlist.run({ id: e.id, label: e.label ?? "", addedAt: e.addedAt ?? null });
    });

    const insertBillsAccess = handle.prepare(
      `INSERT INTO billsAccess (id, addedAt) VALUES (:id, :addedAt)`
    );
    Object.values(data.billsAccess || {}).forEach((e) => {
      insertBillsAccess.run({ id: e.id, addedAt: e.addedAt ?? null });
    });

    handle.exec("COMMIT");
  } catch (err) {
    handle.exec("ROLLBACK");
    throw err;
  }

  // Independent verification pass beyond the transaction itself: every
  // collection's row count must match the source JSON exactly, or we
  // treat the whole migration as failed.
  const collections = ["users", "characters", "notes", "reminders", "bills", "allowlist", "billsAccess"];
  for (const table of collections) {
    const expected = data[table] ? Object.keys(data[table]).length : 0;
    const actual = handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    if (actual !== expected) {
      throw new Error(`Migration verification failed for "${table}": expected ${expected} rows, found ${actual}.`);
    }
  }
}

function initDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(SQLITE_FILE)) {
    // Already fully initialized/migrated in a previous run.
    db = new DatabaseSync(SQLITE_FILE);
    applyPragmas(db);
    ensureSchemaUpToDate(db);
    return;
  }

  // Clean up any incomplete attempt left behind by a crash mid-migration.
  if (fs.existsSync(BUILDING_FILE)) fs.rmSync(BUILDING_FILE);

  const building = new DatabaseSync(BUILDING_FILE);
  applyPragmas(building);
  building.exec(SCHEMA_SQL);

  if (fs.existsSync(LEGACY_JSON_FILE)) {
    migrateFromJson(building, LEGACY_JSON_FILE); // throws on any problem
  }

  building.close();
  // Only becomes the "real" file once schema + migration + verification
  // have all fully succeeded -- this rename is the atomic success signal.
  fs.renameSync(BUILDING_FILE, SQLITE_FILE);

  if (fs.existsSync(LEGACY_JSON_FILE)) {
    const backupPath = `${LEGACY_JSON_FILE}.migrated-${Date.now()}.bak`;
    fs.renameSync(LEGACY_JSON_FILE, backupPath);
    console.log(`[store] Migrated data/db.json to SQLite (data/${path.basename(SQLITE_FILE)}). Original kept as data/${path.basename(backupPath)}.`);
  }

  db = new DatabaseSync(SQLITE_FILE);
  applyPragmas(db);
}

initDb();

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- row -> JS object mappers ----------
function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id, username: row.username, avatar: row.avatar, timezone: row.timezone,
    incomeEstimate: row.incomeEstimate, incomeCurrency: row.incomeCurrency, updatedAt: row.updatedAt,
    authType: row.authType || "discord", mustChangePassword: !!row.mustChangePassword,
    digestFrequency: row.digestFrequency || "off", lastLoginAt: row.lastLoginAt || null,
    lastDigestSentAt: row.lastDigestSentAt || null, defaultCurrency: row.defaultCurrency || "USD",
    billCategories: row.billCategories ? JSON.parse(row.billCategories) : DEFAULT_BILL_CATEGORIES.slice()
  };
}

function rowToCharacter(row) {
  if (!row) return null;
  return { id: row.id, ownerId: row.ownerId, name: row.name, color: row.color, createdAt: row.createdAt };
}

function rowToNote(row) {
  if (!row) return null;
  return {
    id: row.id, ownerId: row.ownerId, characterId: row.characterId,
    title: row.title, body: row.body,
    tags: row.tags ? JSON.parse(row.tags) : [],
    sticky: !!row.sticky, spoiler: !!row.spoiler, dueDate: row.dueDate,
    createdAt: row.createdAt, updatedAt: row.updatedAt, deletedAt: row.deletedAt || null,
    prevTitle: row.prevTitle, prevBody: row.prevBody, prevSavedAt: row.prevSavedAt
  };
}

function rowToReminder(row) {
  if (!row) return null;
  return {
    id: row.id, ownerId: row.ownerId, noteId: row.noteId, noteTitle: row.noteTitle,
    fireAt: row.fireAt, repeat: !!row.repeat, repeatInterval: row.repeatInterval, createdAt: row.createdAt
  };
}

function rowToBill(row) {
  if (!row) return null;
  return {
    id: row.id, ownerId: row.ownerId, name: row.name, amount: row.amount, currency: row.currency,
    dueDate: row.dueDate, frequency: row.frequency, category: row.category,
    autoPay: !!row.autoPay, url: row.url, color: row.color, notes: row.notes,
    reminderDays: row.reminderDays, paid: !!row.paid,
    paidDates: row.paidDates ? JSON.parse(row.paidDates) : [],
    lastReminderSent: row.lastReminderSent, createdAt: row.createdAt,
    deletedAt: row.deletedAt || null,
    priority: row.priority || "medium"
  };
}

function rowToAllowlistEntry(row) {
  if (!row) return null;
  return { id: row.id, label: row.label, addedAt: row.addedAt };
}

function rowToBillsAccessEntry(row) {
  if (!row) return null;
  return { id: row.id, addedAt: row.addedAt };
}

// ---------- users ----------
async function upsertUser(discordUser) {
  const existing = db.prepare("SELECT * FROM users WHERE id = :id").get({ id: discordUser.id });
  const avatar = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
    : null;
  const updatedAt = Date.now();
  if (existing) {
    db.prepare("UPDATE users SET username = :username, avatar = :avatar, updatedAt = :updatedAt WHERE id = :id")
      .run({ id: discordUser.id, username: discordUser.username, avatar, updatedAt });
  } else {
    db.prepare(
      `INSERT INTO users (id, username, avatar, timezone, incomeEstimate, incomeCurrency, updatedAt)
       VALUES (:id, :username, :avatar, NULL, NULL, NULL, :updatedAt)`
    ).run({ id: discordUser.id, username: discordUser.username, avatar, updatedAt });
  }
  return rowToUser(db.prepare("SELECT * FROM users WHERE id = :id").get({ id: discordUser.id }));
}

function getUser(id) {
  return rowToUser(db.prepare("SELECT * FROM users WHERE id = :id").get({ id }));
}

async function updateUserTimezone(id, timezone) {
  const existing = db.prepare("SELECT * FROM users WHERE id = :id").get({ id });
  if (!existing) return null;
  db.prepare("UPDATE users SET timezone = :timezone WHERE id = :id").run({ id, timezone });
  return rowToUser({ ...existing, timezone });
}

async function updateUserIncome(id, amount, currency) {
  const existing = db.prepare("SELECT * FROM users WHERE id = :id").get({ id });
  if (!existing) return null;
  const incomeEstimate = amount != null ? Number(amount) : null;
  const incomeCurrency = currency || existing.incomeCurrency || "USD";
  db.prepare("UPDATE users SET incomeEstimate = :incomeEstimate, incomeCurrency = :incomeCurrency WHERE id = :id")
    .run({ id, incomeEstimate, incomeCurrency });
  return rowToUser({ ...existing, incomeEstimate, incomeCurrency });
}

const BILL_CURRENCIES = ["CAD", "USD", "EUR", "GBP", "AUD", "NZD", "CHF", "JPY", "SEK", "NOK", "DKK"];

async function updateDefaultCurrency(id, currency) {
  if (!BILL_CURRENCIES.includes(currency)) throw new Error("Invalid currency.");
  const existing = db.prepare("SELECT * FROM users WHERE id = :id").get({ id });
  if (!existing) return null;
  db.prepare("UPDATE users SET defaultCurrency = :defaultCurrency WHERE id = :id").run({ id, defaultCurrency: currency });
  return rowToUser({ ...existing, defaultCurrency: currency });
}

// Relabels every bill this owner has to a new currency -- does not convert
// amounts, just changes the currency code stored alongside them. Used when
// the user opts to have their existing bills follow a new default currency.
async function updateAllBillsCurrency(ownerId, currency) {
  if (!BILL_CURRENCIES.includes(currency)) throw new Error("Invalid currency.");
  const result = db.prepare("UPDATE bills SET currency = :currency WHERE ownerId = :ownerId").run({ ownerId, currency });
  return Number(result.changes);
}

async function updateBillCategories(id, categories) {
  if (!Array.isArray(categories)) throw new Error("Categories must be a list.");
  const seen = new Set();
  const cleaned = [];
  for (const raw of categories) {
    const c = typeof raw === "string" ? raw.trim() : "";
    if (!c || c.length > 30) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(c);
  }
  if (!cleaned.length) throw new Error("At least one category is required.");
  if (cleaned.length > 40) throw new Error("Too many categories.");
  const existing = db.prepare("SELECT * FROM users WHERE id = :id").get({ id });
  if (!existing) return null;
  const billCategories = JSON.stringify(cleaned);
  db.prepare("UPDATE users SET billCategories = :billCategories WHERE id = :id").run({ id, billCategories });
  return rowToUser({ ...existing, billCategories });
}

// Self-service "remove my data" -- wipes everything owned by this account
// (characters, notes, reminders, bills) and resets stored preferences.
// Does not touch the allowlist/billsAccess grant or the account row itself,
// so the user can still log back in with a clean slate.
async function deleteAllUserData(id) {
  db.prepare("DELETE FROM notes WHERE ownerId = :ownerId").run({ ownerId: id });
  db.prepare("DELETE FROM characters WHERE ownerId = :ownerId").run({ ownerId: id });
  db.prepare("DELETE FROM reminders WHERE ownerId = :ownerId").run({ ownerId: id });
  db.prepare("DELETE FROM bills WHERE ownerId = :ownerId").run({ ownerId: id });
  db.prepare("UPDATE users SET timezone = NULL, incomeEstimate = NULL, incomeCurrency = NULL WHERE id = :id")
    .run({ id });
}

// ---------- local (non-Discord) accounts ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPasswordAgainstHash(password, stored) {
  if (!stored) return false;
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function createLocalAccount(username, password) {
  const trimmed = String(username || "").trim();
  const existing = db.prepare("SELECT id FROM users WHERE authType = 'local' AND LOWER(username) = LOWER(:username)")
    .get({ username: trimmed });
  if (existing) throw new Error("That username is already taken.");
  const id = "local_" + uid();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, username, avatar, timezone, incomeEstimate, incomeCurrency, updatedAt, passwordHash, authType, mustChangePassword)
     VALUES (:id, :username, NULL, NULL, NULL, NULL, :updatedAt, :passwordHash, 'local', 1)`
  ).run({ id, username: trimmed, updatedAt: now, passwordHash: hashPassword(password) });
  return rowToUser(db.prepare("SELECT * FROM users WHERE id = :id").get({ id }));
}

function listLocalAccounts() {
  return db.prepare("SELECT * FROM users WHERE authType = 'local'").all()
    .map(rowToUser)
    .sort((a, b) => (a.username || "").localeCompare(b.username || ""));
}

function verifyLocalLogin(username, password) {
  const row = db.prepare("SELECT * FROM users WHERE authType = 'local' AND LOWER(username) = LOWER(:username)")
    .get({ username: String(username || "").trim() });
  if (!row || !verifyPasswordAgainstHash(password, row.passwordHash)) return null;
  return rowToUser(row);
}

async function changeOwnPassword(id, currentPassword, newPassword) {
  const row = db.prepare("SELECT * FROM users WHERE id = :id AND authType = 'local'").get({ id });
  if (!row) return false;
  if (!verifyPasswordAgainstHash(currentPassword, row.passwordHash)) return false;
  db.prepare("UPDATE users SET passwordHash = :passwordHash, mustChangePassword = 0 WHERE id = :id")
    .run({ id, passwordHash: hashPassword(newPassword) });
  return true;
}

async function adminResetPassword(id, newPassword) {
  const row = db.prepare("SELECT * FROM users WHERE id = :id AND authType = 'local'").get({ id });
  if (!row) return null;
  db.prepare("UPDATE users SET passwordHash = :passwordHash, mustChangePassword = 1 WHERE id = :id")
    .run({ id, passwordHash: hashPassword(newPassword) });
  return rowToUser({ ...row, mustChangePassword: 1 });
}

// Fully removes a local account: unlike the self-service "remove my data"
// flow, there's no external (Discord) identity left behind to preserve, so
// this also deletes the account row itself and any Bills-access grant.
async function deleteLocalAccount(id) {
  const row = db.prepare("SELECT id FROM users WHERE id = :id AND authType = 'local'").get({ id });
  if (!row) return false;
  await deleteAllUserData(id);
  db.prepare("DELETE FROM users WHERE id = :id AND authType = 'local'").run({ id });
  await revokeBillsAccess(id);
  return true;
}

async function recordLogin(id) {
  db.prepare("UPDATE users SET lastLoginAt = :lastLoginAt WHERE id = :id").run({ id, lastLoginAt: Date.now() });
}

// icalToken is deliberately excluded from rowToUser -- it's a bearer
// credential for the unauthenticated .ics feed route, only ever handed
// back through these dedicated functions/endpoints.
async function getOrCreateIcalToken(id) {
  const row = db.prepare("SELECT icalToken FROM users WHERE id = :id").get({ id });
  if (!row) return null;
  if (row.icalToken) return row.icalToken;
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("UPDATE users SET icalToken = :icalToken WHERE id = :id").run({ id, icalToken: token });
  return token;
}

async function regenerateIcalToken(id) {
  const row = db.prepare("SELECT id FROM users WHERE id = :id").get({ id });
  if (!row) return null;
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("UPDATE users SET icalToken = :icalToken WHERE id = :id").run({ id, icalToken: token });
  return token;
}

function getUserByIcalToken(token) {
  if (!token) return null;
  return rowToUser(db.prepare("SELECT * FROM users WHERE icalToken = :token").get({ token }));
}

const DIGEST_FREQUENCIES = ["off", "daily", "weekly", "monthly"];

async function updateDigestFrequency(id, frequency) {
  if (!DIGEST_FREQUENCIES.includes(frequency)) throw new Error("Invalid digest frequency.");
  const row = db.prepare("SELECT * FROM users WHERE id = :id").get({ id });
  if (!row) return null;
  db.prepare("UPDATE users SET digestFrequency = :digestFrequency WHERE id = :id").run({ id, digestFrequency: frequency });
  return rowToUser({ ...row, digestFrequency: frequency });
}

function listUsersWithDigestEnabled() {
  return db.prepare("SELECT * FROM users WHERE authType = 'discord' AND digestFrequency != 'off'").all()
    .map(rowToUser);
}

async function markDigestSent(id) {
  db.prepare("UPDATE users SET lastDigestSentAt = :lastDigestSentAt WHERE id = :id").run({ id, lastDigestSentAt: Date.now() });
}

// ---------- characters ----------
function listCharacters(ownerId) {
  return db.prepare("SELECT * FROM characters WHERE ownerId = :ownerId").all({ ownerId })
    .map(rowToCharacter)
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function createCharacter(ownerId, partial) {
  const character = {
    id: uid(), ownerId, name: (partial.name || "").slice(0, 64),
    color: partial.color || "#e8a33d", createdAt: Date.now()
  };
  db.prepare("INSERT INTO characters (id, ownerId, name, color, createdAt) VALUES (:id, :ownerId, :name, :color, :createdAt)")
    .run({ id: character.id, ownerId: character.ownerId, name: character.name, color: character.color, createdAt: character.createdAt });
  return character;
}

async function updateCharacter(ownerId, id, partial) {
  const row = db.prepare("SELECT * FROM characters WHERE id = :id").get({ id });
  if (!row || row.ownerId !== ownerId) return null;
  const name = typeof partial.name === "string" ? partial.name.slice(0, 64) : row.name;
  const color = typeof partial.color === "string" ? partial.color : row.color;
  db.prepare("UPDATE characters SET name = :name, color = :color WHERE id = :id").run({ id, name, color });
  return rowToCharacter({ ...row, name, color });
}

async function deleteCharacter(ownerId, id) {
  const row = db.prepare("SELECT * FROM characters WHERE id = :id").get({ id });
  if (!row || row.ownerId !== ownerId) return false;
  db.prepare("DELETE FROM characters WHERE id = :id").run({ id });
  // Matches original behavior: only this owner's notes for this character are
  // removed -- but they go to the trash rather than vanishing outright.
  db.prepare("UPDATE notes SET deletedAt = :deletedAt WHERE characterId = :characterId AND ownerId = :ownerId AND deletedAt IS NULL")
    .run({ characterId: id, ownerId, deletedAt: Date.now() });
  return true;
}

// ---------- notes ----------
function listNotes(ownerId, characterId) {
  const requestedCharacterId = characterId || null;
  return db.prepare("SELECT * FROM notes WHERE ownerId = :ownerId AND deletedAt IS NULL").all({ ownerId })
    .map(rowToNote)
    .filter((n) => {
      if (characterId === "__all__") return true;
      return n.sticky || (n.characterId || null) === requestedCharacterId;
    })
    .sort((a, b) => {
      if (a.sticky !== b.sticky) return a.sticky ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
}

function getNote(ownerId, id) {
  const row = db.prepare("SELECT * FROM notes WHERE id = :id AND deletedAt IS NULL").get({ id });
  if (!row || row.ownerId !== ownerId) return null;
  return rowToNote(row);
}

async function createNote(ownerId, partial) {
  const now = Date.now();
  const note = {
    id: uid(), ownerId,
    characterId: partial.characterId || null,
    title: partial.title || "",
    body: partial.body || "",
    tags: Array.isArray(partial.tags) ? partial.tags : [],
    sticky: Boolean(partial.sticky),
    spoiler: Boolean(partial.spoiler),
    dueDate: partial.dueDate || null,
    createdAt: now, updatedAt: now
  };
  db.prepare(
    `INSERT INTO notes (id, ownerId, characterId, title, body, tags, sticky, spoiler, dueDate, createdAt, updatedAt)
     VALUES (:id, :ownerId, :characterId, :title, :body, :tags, :sticky, :spoiler, :dueDate, :createdAt, :updatedAt)`
  ).run({
    id: note.id, ownerId: note.ownerId, characterId: note.characterId, title: note.title, body: note.body,
    tags: JSON.stringify(note.tags), sticky: note.sticky ? 1 : 0, spoiler: note.spoiler ? 1 : 0, dueDate: note.dueDate,
    createdAt: note.createdAt, updatedAt: note.updatedAt
  });
  return note;
}

async function updateNote(ownerId, id, partial) {
  const row = db.prepare("SELECT * FROM notes WHERE id = :id AND deletedAt IS NULL").get({ id });
  if (!row || row.ownerId !== ownerId) return null;
  const note = rowToNote(row);
  const contentChanged =
    (typeof partial.title === "string" && partial.title !== row.title) ||
    (typeof partial.body === "string" && partial.body !== row.body);
  if (typeof partial.title === "string") note.title = partial.title;
  if (typeof partial.body === "string") note.body = partial.body;
  if (Array.isArray(partial.tags)) note.tags = partial.tags;
  if (typeof partial.sticky === "boolean") note.sticky = partial.sticky;
  if (typeof partial.spoiler === "boolean") note.spoiler = partial.spoiler;
  if ("dueDate" in partial) note.dueDate = partial.dueDate || null;
  note.updatedAt = Date.now();
  // Keep a single-level "previous saved version" snapshot so an accidental
  // paste-over that gets autosaved isn't unrecoverable.
  if (contentChanged) {
    note.prevTitle = row.title;
    note.prevBody = row.body;
    note.prevSavedAt = note.updatedAt;
  }
  db.prepare(
    `UPDATE notes SET title = :title, body = :body, tags = :tags, sticky = :sticky, spoiler = :spoiler, dueDate = :dueDate, updatedAt = :updatedAt,
     prevTitle = :prevTitle, prevBody = :prevBody, prevSavedAt = :prevSavedAt
     WHERE id = :id`
  ).run({
    id, title: note.title, body: note.body, tags: JSON.stringify(note.tags),
    sticky: note.sticky ? 1 : 0, spoiler: note.spoiler ? 1 : 0, dueDate: note.dueDate, updatedAt: note.updatedAt,
    prevTitle: note.prevTitle ?? null, prevBody: note.prevBody ?? null, prevSavedAt: note.prevSavedAt ?? null
  });
  return note;
}

async function restorePreviousVersion(ownerId, id) {
  const row = db.prepare("SELECT * FROM notes WHERE id = :id AND deletedAt IS NULL").get({ id });
  if (!row || row.ownerId !== ownerId) return null;
  if (row.prevBody == null && row.prevTitle == null) return null;
  const now = Date.now();
  const restored = {
    title: row.prevTitle ?? "",
    body: row.prevBody ?? "",
    // The restore itself becomes undoable by swapping the current content in as "previous".
    prevTitle: row.title,
    prevBody: row.body,
    prevSavedAt: now,
    updatedAt: now
  };
  db.prepare(
    `UPDATE notes SET title = :title, body = :body, updatedAt = :updatedAt,
     prevTitle = :prevTitle, prevBody = :prevBody, prevSavedAt = :prevSavedAt
     WHERE id = :id`
  ).run({ id, ...restored });
  return rowToNote({ ...row, ...restored });
}

// Deletes are soft: the row gets a deletedAt and moves to the trash, where it
// stays restorable until purged. Any reminders are dropped outright -- a note
// sitting in the trash shouldn't keep pinging you, and re-adding a reminder
// after a restore is trivial.
async function deleteNote(ownerId, id) {
  const row = db.prepare("SELECT * FROM notes WHERE id = :id AND deletedAt IS NULL").get({ id });
  if (!row || row.ownerId !== ownerId) return false;
  db.prepare("UPDATE notes SET deletedAt = :deletedAt WHERE id = :id").run({ id, deletedAt: Date.now() });
  db.prepare("DELETE FROM reminders WHERE noteId = :noteId").run({ noteId: id });
  return true;
}

async function clearNotes(ownerId, characterId) {
  const requestedCharacterId = characterId || null;
  const rows = db.prepare("SELECT id, characterId FROM notes WHERE ownerId = :ownerId AND deletedAt IS NULL").all({ ownerId });
  const idsToDelete = rows
    .filter((n) => characterId === "__all__" || (n.characterId || null) === requestedCharacterId)
    .map((n) => n.id);
  const now = Date.now();
  for (const id of idsToDelete) {
    db.prepare("UPDATE notes SET deletedAt = :deletedAt WHERE id = :id").run({ id, deletedAt: now });
    db.prepare("DELETE FROM reminders WHERE noteId = :noteId").run({ noteId: id });
  }
}

// ---------- reminders ----------
function listReminders(ownerId) {
  return db.prepare("SELECT * FROM reminders WHERE ownerId = :ownerId").all({ ownerId })
    .map(rowToReminder)
    .sort((a, b) => a.fireAt - b.fireAt);
}

function listRemindersForNote(ownerId, noteId) {
  return db.prepare("SELECT * FROM reminders WHERE ownerId = :ownerId AND noteId = :noteId").all({ ownerId, noteId })
    .map(rowToReminder)
    .sort((a, b) => a.fireAt - b.fireAt);
}

function getDueReminders() {
  const now = Date.now();
  return db.prepare("SELECT * FROM reminders WHERE fireAt <= :now").all({ now }).map(rowToReminder);
}

async function createReminder(ownerId, partial) {
  const reminder = {
    id: uid(), ownerId,
    noteId: partial.noteId,
    noteTitle: partial.noteTitle || "",
    fireAt: partial.fireAt,
    repeat: partial.repeat || false,
    repeatInterval: partial.repeatInterval || null,
    createdAt: Date.now()
  };
  db.prepare(
    `INSERT INTO reminders (id, ownerId, noteId, noteTitle, fireAt, repeat, repeatInterval, createdAt)
     VALUES (:id, :ownerId, :noteId, :noteTitle, :fireAt, :repeat, :repeatInterval, :createdAt)`
  ).run({
    id: reminder.id, ownerId: reminder.ownerId, noteId: reminder.noteId, noteTitle: reminder.noteTitle,
    fireAt: reminder.fireAt, repeat: reminder.repeat ? 1 : 0, repeatInterval: reminder.repeatInterval,
    createdAt: reminder.createdAt
  });
  return reminder;
}

async function rescheduleReminder(id, intervalMs) {
  const row = db.prepare("SELECT * FROM reminders WHERE id = :id").get({ id });
  if (!row) return null;
  const fireAt = Date.now() + intervalMs;
  db.prepare("UPDATE reminders SET fireAt = :fireAt WHERE id = :id").run({ id, fireAt });
  const reminder = rowToReminder(row);
  reminder.fireAt = fireAt;
  return reminder;
}

async function deleteReminder(ownerId, id) {
  const row = db.prepare("SELECT * FROM reminders WHERE id = :id").get({ id });
  if (!row || row.ownerId !== ownerId) return false;
  db.prepare("DELETE FROM reminders WHERE id = :id").run({ id });
  return true;
}

// ---------- bills (per-user, gated by bills access) ----------
function dateToStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Adds calendar months while clamping to the target month's last day,
// so e.g. Jan 31 + 1 month lands on Feb 28/29, not overflowing into March.
function addMonthsClamped(d, months) {
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInMonth));
  return d;
}

function advanceDueDate(dateStr, frequency) {
  const d = new Date(dateStr + "T00:00:00");
  switch (frequency) {
    case "weekly":    d.setDate(d.getDate() + 7); break;
    case "biweekly":  d.setDate(d.getDate() + 14); break;
    case "monthly":   addMonthsClamped(d, 1); break;
    case "quarterly": addMonthsClamped(d, 3); break;
    case "yearly":    d.setFullYear(d.getFullYear() + 1); break;
  }
  return dateToStr(d);
}

function listBills(ownerId) {
  return db.prepare("SELECT * FROM bills WHERE ownerId = :ownerId AND deletedAt IS NULL").all({ ownerId })
    .map(rowToBill)
    .sort((a, b) => {
      if (a.dueDate && b.dueDate) {
        const cmp = a.dueDate.localeCompare(b.dueDate);
        if (cmp !== 0) return cmp;
        return (PRIORITY_ORDER[b.priority] ?? 1) - (PRIORITY_ORDER[a.priority] ?? 1);
      }
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return (a.name || "").localeCompare(b.name || "");
    });
}

function getBill(ownerId, id) {
  const row = db.prepare("SELECT * FROM bills WHERE id = :id AND deletedAt IS NULL").get({ id });
  if (!row || row.ownerId !== ownerId) return null;
  return rowToBill(row);
}

async function createBill(ownerId, partial) {
  const priority = BILL_PRIORITIES.includes(partial.priority) ? partial.priority : "medium";
  const bill = {
    id: uid(), ownerId,
    name:         partial.name || "New bill",
    amount:       parseFloat(partial.amount) || 0,
    currency:     partial.currency || "USD",
    dueDate:      partial.dueDate || null,
    frequency:    partial.frequency || "monthly",
    category:     partial.category || "Other",
    autoPay:      Boolean(partial.autoPay),
    url:          partial.url || "",
    color:        PRIORITY_COLORS[priority],
    notes:        partial.notes || "",
    reminderDays: partial.reminderDays != null ? Number(partial.reminderDays) : null,
    paid:         false,
    paidDates:    [],
    lastReminderSent: null,
    createdAt:    Date.now(),
    priority
  };
  db.prepare(
    `INSERT INTO bills (id, ownerId, name, amount, currency, dueDate, frequency, category, autoPay, url, color, notes, reminderDays, paid, paidDates, lastReminderSent, createdAt, priority)
     VALUES (:id, :ownerId, :name, :amount, :currency, :dueDate, :frequency, :category, :autoPay, :url, :color, :notes, :reminderDays, :paid, :paidDates, :lastReminderSent, :createdAt, :priority)`
  ).run({
    id: bill.id, ownerId: bill.ownerId, name: bill.name, amount: bill.amount, currency: bill.currency,
    dueDate: bill.dueDate, frequency: bill.frequency, category: bill.category, autoPay: bill.autoPay ? 1 : 0,
    url: bill.url, color: bill.color, notes: bill.notes, reminderDays: bill.reminderDays,
    paid: bill.paid ? 1 : 0, paidDates: JSON.stringify(bill.paidDates), lastReminderSent: bill.lastReminderSent,
    createdAt: bill.createdAt, priority: bill.priority
  });
  return bill;
}

async function updateBill(ownerId, id, partial) {
  const row = db.prepare("SELECT * FROM bills WHERE id = :id AND deletedAt IS NULL").get({ id });
  if (!row || row.ownerId !== ownerId) return null;
  const bill = rowToBill(row);
  // "paid" is intentionally excluded -- it's only mutated via markBillPaid/markBillUnpaid,
  // which also keep paidDates and dueDate advancement in sync.
  const fields = ["name","amount","currency","dueDate","frequency","category","autoPay","url","notes","reminderDays"];
  fields.forEach(f => { if (f in partial) bill[f] = partial[f]; });
  if (typeof bill.amount === "string") bill.amount = parseFloat(bill.amount) || 0;
  // Color is derived from priority, not independently settable -- picking a
  // priority level recolors the bill everywhere it's shown.
  if (BILL_PRIORITIES.includes(partial.priority)) {
    bill.priority = partial.priority;
    bill.color = PRIORITY_COLORS[bill.priority];
  }
  db.prepare(
    `UPDATE bills SET name=:name, amount=:amount, currency=:currency, dueDate=:dueDate, frequency=:frequency,
     category=:category, autoPay=:autoPay, url=:url, color=:color, notes=:notes, reminderDays=:reminderDays,
     priority=:priority
     WHERE id=:id`
  ).run({
    id, name: bill.name, amount: bill.amount, currency: bill.currency, dueDate: bill.dueDate,
    frequency: bill.frequency, category: bill.category, autoPay: bill.autoPay ? 1 : 0, url: bill.url,
    color: bill.color, notes: bill.notes, reminderDays: bill.reminderDays, priority: bill.priority
  });
  return bill;
}

async function markBillPaid(ownerId, id) {
  const row = db.prepare("SELECT * FROM bills WHERE id = :id AND deletedAt IS NULL").get({ id });
  if (!row || row.ownerId !== ownerId) return null;
  const bill = rowToBill(row);
  const today = dateToStr(new Date());
  if (!bill.paidDates) bill.paidDates = [];
  bill.paidDates.unshift(today);
  if (bill.frequency === "one-time") {
    bill.paid = true;
  } else if (bill.dueDate) {
    bill.dueDate = advanceDueDate(bill.dueDate, bill.frequency);
    bill.paid = false;
  }
  db.prepare("UPDATE bills SET dueDate = :dueDate, paid = :paid, paidDates = :paidDates WHERE id = :id")
    .run({ id, dueDate: bill.dueDate, paid: bill.paid ? 1 : 0, paidDates: JSON.stringify(bill.paidDates) });
  return bill;
}

async function markBillUnpaid(ownerId, id) {
  const row = db.prepare("SELECT * FROM bills WHERE id = :id AND deletedAt IS NULL").get({ id });
  if (!row || row.ownerId !== ownerId) return null;
  db.prepare("UPDATE bills SET paid = 0 WHERE id = :id").run({ id });
  const bill = rowToBill(row);
  bill.paid = false;
  return bill;
}

async function deleteBill(ownerId, id) {
  const row = db.prepare("SELECT * FROM bills WHERE id = :id AND deletedAt IS NULL").get({ id });
  if (!row || row.ownerId !== ownerId) return false;
  db.prepare("UPDATE bills SET deletedAt = :deletedAt WHERE id = :id").run({ id, deletedAt: Date.now() });
  return true;
}

// ---------- trash ----------
// Deleted notes and bills stay recoverable for this many days, then a purge
// job clears them for good.
const TRASH_RETENTION_DAYS = 30;

function listTrash(ownerId) {
  const notes = db.prepare("SELECT * FROM notes WHERE ownerId = :ownerId AND deletedAt IS NOT NULL").all({ ownerId })
    .map(rowToNote)
    .sort((a, b) => b.deletedAt - a.deletedAt);
  const bills = db.prepare("SELECT * FROM bills WHERE ownerId = :ownerId AND deletedAt IS NOT NULL").all({ ownerId })
    .map(rowToBill)
    .sort((a, b) => b.deletedAt - a.deletedAt);
  return { notes, bills, retentionDays: TRASH_RETENTION_DAYS };
}

function trashTable(type) {
  if (type === "note") return "notes";
  if (type === "bill") return "bills";
  return null;
}

async function restoreFromTrash(ownerId, type, id) {
  const table = trashTable(type);
  if (!table) return false;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = :id AND deletedAt IS NOT NULL`).get({ id });
  if (!row || row.ownerId !== ownerId) return false;
  db.prepare(`UPDATE ${table} SET deletedAt = NULL WHERE id = :id`).run({ id });
  return true;
}

async function deleteFromTrashPermanently(ownerId, type, id) {
  const table = trashTable(type);
  if (!table) return false;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = :id AND deletedAt IS NOT NULL`).get({ id });
  if (!row || row.ownerId !== ownerId) return false;
  db.prepare(`DELETE FROM ${table} WHERE id = :id`).run({ id });
  return true;
}

async function emptyTrash(ownerId) {
  const notes = db.prepare("DELETE FROM notes WHERE ownerId = :ownerId AND deletedAt IS NOT NULL").run({ ownerId });
  const bills = db.prepare("DELETE FROM bills WHERE ownerId = :ownerId AND deletedAt IS NOT NULL").run({ ownerId });
  return { notes: Number(notes.changes), bills: Number(bills.changes) };
}

// ---------- import ----------
// Imports are strictly additive: nothing already in the account is modified or
// removed. Everything lands owned by the importing user regardless of what the
// file claims, and IDs are always regenerated so a file can never collide with
// (or overwrite) existing rows. Reminders are deliberately not imported --
// replaying stale ones would fire a burst of DMs for things already past.
function importNorm(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function importKey(type, index) {
  return type + ":" + index;
}

function importSections(data) {
  const safe = data && typeof data === "object" ? data : {};
  return {
    characters: Array.isArray(safe.characters) ? safe.characters : [],
    notes: Array.isArray(safe.notes) ? safe.notes : [],
    bills: Array.isArray(safe.bills) ? safe.bills : []
  };
}

function noteFingerprint(n) { return importNorm(n.title) + " " + importNorm(n.body); }
function billFingerprint(b) { return importNorm(b.name) + " " + (parseFloat(b.amount) || 0) + " " + (b.dueDate || ""); }

// Reports what a file would add and which entries look like things the account
// already has, so the user can decide what to do about each one.
function analyzeImport(ownerId, data) {
  const { characters, notes, bills } = importSections(data);
  const existingChars = new Set(listCharacters(ownerId).map((c) => importNorm(c.name)));
  const existingNotes = new Set(listNotes(ownerId, "__all__").map(noteFingerprint));
  const existingBills = new Set(listBills(ownerId).map(billFingerprint));

  const duplicates = [];
  characters.forEach((c, i) => {
    if (existingChars.has(importNorm(c.name))) {
      duplicates.push({ key: importKey("character", i), type: "character", label: c.name || "Unnamed character" });
    }
  });
  notes.forEach((n, i) => {
    if (existingNotes.has(noteFingerprint(n))) {
      duplicates.push({ key: importKey("note", i), type: "note", label: n.title || "Untitled" });
    }
  });
  bills.forEach((b, i) => {
    if (existingBills.has(billFingerprint(b))) {
      duplicates.push({ key: importKey("bill", i), type: "bill", label: b.name || "Untitled bill" });
    }
  });

  return {
    counts: { characters: characters.length, notes: notes.length, bills: bills.length },
    duplicates
  };
}

async function importData(ownerId, data, skipKeys) {
  const { characters, notes, bills } = importSections(data);
  const skip = new Set(Array.isArray(skipKeys) ? skipKeys : []);
  const existingChars = new Map(listCharacters(ownerId).map((c) => [importNorm(c.name), c]));
  const charIdMap = new Map();
  const result = { characters: 0, notes: 0, bills: 0, skipped: 0 };

  for (let i = 0; i < characters.length; i++) {
    const c = characters[i];
    const existing = existingChars.get(importNorm(c.name));
    if (skip.has(importKey("character", i))) {
      result.skipped++;
      // A skipped duplicate still needs to resolve, so this file's notes attach
      // to the character already in the account rather than going loose.
      if (c.id && existing) charIdMap.set(c.id, existing.id);
      continue;
    }
    const created = await createCharacter(ownerId, { name: c.name, color: c.color });
    if (c.id) charIdMap.set(c.id, created.id);
    result.characters++;
  }

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (skip.has(importKey("note", i))) { result.skipped++; continue; }
    await createNote(ownerId, {
      characterId: n.characterId ? (charIdMap.get(n.characterId) || null) : null,
      title: n.title, body: n.body, tags: n.tags,
      sticky: n.sticky, spoiler: n.spoiler, dueDate: n.dueDate
    });
    result.notes++;
  }

  for (let i = 0; i < bills.length; i++) {
    const b = bills[i];
    if (skip.has(importKey("bill", i))) { result.skipped++; continue; }
    const created = await createBill(ownerId, b);
    // createBill deliberately starts every bill unpaid with no history, so the
    // imported payment record is restored separately.
    const paidDates = Array.isArray(b.paidDates) ? b.paidDates : [];
    if (b.paid || paidDates.length) {
      db.prepare("UPDATE bills SET paid = :paid, paidDates = :paidDates WHERE id = :id")
        .run({ id: created.id, paid: b.paid ? 1 : 0, paidDates: JSON.stringify(paidDates) });
    }
    result.bills++;
  }

  return result;
}

// Unscoped by owner -- driven by the server's scheduled purge job.
async function purgeExpiredTrash(retentionDays = TRASH_RETENTION_DAYS) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const notes = db.prepare("DELETE FROM notes WHERE deletedAt IS NOT NULL AND deletedAt <= :cutoff").run({ cutoff });
  const bills = db.prepare("DELETE FROM bills WHERE deletedAt IS NOT NULL AND deletedAt <= :cutoff").run({ cutoff });
  return { notes: Number(notes.changes), bills: Number(bills.changes) };
}

// Internal-only: unscoped by owner, used by the server's bill-reminder job.
function getAllBills() {
  return db.prepare("SELECT * FROM bills WHERE deletedAt IS NULL").all().map(rowToBill);
}

async function markBillReminderSent(id, dateStr) {
  const row = db.prepare("SELECT * FROM bills WHERE id = :id AND deletedAt IS NULL").get({ id });
  if (!row) return null;
  db.prepare("UPDATE bills SET lastReminderSent = :lastReminderSent WHERE id = :id").run({ id, lastReminderSent: dateStr });
  const bill = rowToBill(row);
  bill.lastReminderSent = dateStr;
  return bill;
}

// ---------- allowlist (admin-managed guest list) ----------
function listAllowlist() {
  return db.prepare("SELECT * FROM allowlist").all()
    .map(rowToAllowlistEntry)
    .sort((a, b) => a.addedAt - b.addedAt);
}

async function addAllowlistEntry(id, label) {
  id = String(id).trim();
  const entry = { id, label: (label || "").slice(0, 64), addedAt: Date.now() };
  db.prepare("INSERT OR REPLACE INTO allowlist (id, label, addedAt) VALUES (:id, :label, :addedAt)")
    .run({ id: entry.id, label: entry.label, addedAt: entry.addedAt });
  return entry;
}

async function removeAllowlistEntry(id) {
  const row = db.prepare("SELECT * FROM allowlist WHERE id = :id").get({ id });
  if (!row) return false;
  db.prepare("DELETE FROM allowlist WHERE id = :id").run({ id });
  return true;
}

// ---------- bills access (admin-granted, per user) ----------
function listBillsAccess() {
  return db.prepare("SELECT * FROM billsAccess").all()
    .map(rowToBillsAccessEntry)
    .sort((a, b) => a.addedAt - b.addedAt);
}

function hasBillsAccess(id) {
  return !!db.prepare("SELECT 1 AS present FROM billsAccess WHERE id = :id").get({ id });
}

async function grantBillsAccess(id) {
  id = String(id).trim();
  const entry = { id, addedAt: Date.now() };
  db.prepare("INSERT OR REPLACE INTO billsAccess (id, addedAt) VALUES (:id, :addedAt)")
    .run({ id: entry.id, addedAt: entry.addedAt });
  return entry;
}

async function revokeBillsAccess(id) {
  const row = db.prepare("SELECT * FROM billsAccess WHERE id = :id").get({ id });
  if (!row) return false;
  db.prepare("DELETE FROM billsAccess WHERE id = :id").run({ id });
  return true;
}

module.exports = {
  upsertUser, getUser, updateUserTimezone, updateUserIncome, updateDefaultCurrency, updateAllBillsCurrency, updateBillCategories, deleteAllUserData,
  createLocalAccount, listLocalAccounts, verifyLocalLogin, changeOwnPassword, adminResetPassword, deleteLocalAccount,
  recordLogin, getOrCreateIcalToken, regenerateIcalToken, getUserByIcalToken,
  updateDigestFrequency, listUsersWithDigestEnabled, markDigestSent,
  listCharacters, createCharacter, updateCharacter, deleteCharacter,
  listNotes, getNote, createNote, updateNote, deleteNote, clearNotes, restorePreviousVersion,
  listReminders, listRemindersForNote, getDueReminders, createReminder, rescheduleReminder, deleteReminder,
  listBills, getBill, createBill, updateBill, markBillPaid, markBillUnpaid, deleteBill,
  listTrash, restoreFromTrash, deleteFromTrashPermanently, emptyTrash, purgeExpiredTrash,
  analyzeImport, importData,
  getAllBills, markBillReminderSent,
  listAllowlist, addAllowlistEntry, removeAllowlistEntry,
  listBillsAccess, hasBillsAccess, grantBillsAccess, revokeBillsAccess
};
