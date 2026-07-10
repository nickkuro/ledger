// store.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

let cache = null;
let writeQueue = Promise.resolve();

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {}, characters: {}, notes: {}, reminders: {} }, null, 2));
  }
}

function load() {
  if (cache) return cache;
  ensureFile();
  cache = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!cache.users) cache.users = {};
  if (!cache.characters) cache.characters = {};
  if (!cache.notes) cache.notes = {};
  if (!cache.reminders) cache.reminders = {};
  if (!cache.bills) cache.bills = {};
  if (!cache.allowlist) cache.allowlist = {};
  if (!cache.billsAccess) cache.billsAccess = {};

  // Migrate bills predating per-user ownership to the original admin.
  const legacyOwner = process.env.ADMIN_DISCORD_ID;
  if (legacyOwner) {
    let migrated = false;
    Object.values(cache.bills).forEach((b) => {
      if (!b.ownerId) { b.ownerId = legacyOwner; migrated = true; }
    });
    if (migrated) persist();
  }

  return cache;
}

function persist() {
  const data = cache;
  writeQueue = writeQueue.then(() =>
    new Promise((resolve, reject) => {
      fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
        if (err) reject(err); else resolve();
      });
    })
  );
  return writeQueue;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- users ----------
function upsertUser(discordUser) {
  const db = load();
  const existing = db.users[discordUser.id] || {};
  db.users[discordUser.id] = {
    ...existing,
    id: discordUser.id,
    username: discordUser.username,
    avatar: discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : null,
    updatedAt: Date.now()
  };
  return persist().then(() => db.users[discordUser.id]);
}

function getUser(id) {
  const db = load();
  return db.users[id] || null;
}

function updateUserTimezone(id, timezone) {
  const db = load();
  if (!db.users[id]) return Promise.resolve(null);
  db.users[id].timezone = timezone;
  return persist().then(() => db.users[id]);
}

// ---------- characters ----------
function listCharacters(ownerId) {
  const db = load();
  return Object.values(db.characters)
    .filter((c) => c.ownerId === ownerId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function createCharacter(ownerId, partial) {
  const db = load();
  const id = uid();
  const character = { id, ownerId, name: (partial.name || "").slice(0, 64), color: partial.color || "#e8a33d", createdAt: Date.now() };
  db.characters[id] = character;
  return persist().then(() => character);
}

function updateCharacter(ownerId, id, partial) {
  const db = load();
  const c = db.characters[id];
  if (!c || c.ownerId !== ownerId) return Promise.resolve(null);
  if (typeof partial.name === "string") c.name = partial.name.slice(0, 64);
  if (typeof partial.color === "string") c.color = partial.color;
  return persist().then(() => c);
}

function deleteCharacter(ownerId, id) {
  const db = load();
  const c = db.characters[id];
  if (!c || c.ownerId !== ownerId) return Promise.resolve(false);
  delete db.characters[id];
  Object.keys(db.notes).forEach((nid) => {
    if (db.notes[nid].characterId === id && db.notes[nid].ownerId === ownerId) delete db.notes[nid];
  });
  return persist().then(() => true);
}

// ---------- notes ----------
function listNotes(ownerId, characterId) {
  const db = load();
  const requestedCharacterId = characterId || null;
  return Object.values(db.notes)
    .filter((n) => n.ownerId === ownerId)
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
  const db = load();
  const note = db.notes[id];
  if (!note || note.ownerId !== ownerId) return null;
  return note;
}

function createNote(ownerId, partial) {
  const db = load();
  const id = uid();
  const now = Date.now();
  const note = {
    id,
    ownerId,
    characterId: partial.characterId || null,
    title: partial.title || "",
    body: partial.body || "",
    tags: Array.isArray(partial.tags) ? partial.tags : [],
    sticky: Boolean(partial.sticky),
    dueDate: partial.dueDate || null,
    createdAt: now,
    updatedAt: now
  };
  db.notes[id] = note;
  return persist().then(() => note);
}

function updateNote(ownerId, id, partial) {
  const db = load();
  const note = db.notes[id];
  if (!note || note.ownerId !== ownerId) return Promise.resolve(null);
  if (typeof partial.title === "string") note.title = partial.title;
  if (typeof partial.body === "string") note.body = partial.body;
  if (Array.isArray(partial.tags)) note.tags = partial.tags;
  if (typeof partial.sticky === "boolean") note.sticky = partial.sticky;
  if ("dueDate" in partial) note.dueDate = partial.dueDate || null;
  note.updatedAt = Date.now();
  return persist().then(() => note);
}

function deleteNote(ownerId, id) {
  const db = load();
  const note = db.notes[id];
  if (!note || note.ownerId !== ownerId) return Promise.resolve(false);
  delete db.notes[id];
  // Delete associated reminders
  Object.keys(db.reminders).forEach((rid) => {
    if (db.reminders[rid].noteId === id) delete db.reminders[rid];
  });
  return persist().then(() => true);
}

function clearNotes(ownerId, characterId) {
  const db = load();
  Object.keys(db.notes).forEach((id) => {
    const n = db.notes[id];
    if (n.ownerId !== ownerId) return;
    if (characterId === "__all__" || (n.characterId || null) === (characterId || null)) {
      delete db.notes[id];
      Object.keys(db.reminders).forEach((rid) => {
        if (db.reminders[rid].noteId === id) delete db.reminders[rid];
      });
    }
  });
  return persist();
}

// ---------- reminders ----------
function listReminders(ownerId) {
  const db = load();
  return Object.values(db.reminders)
    .filter((r) => r.ownerId === ownerId)
    .sort((a, b) => a.fireAt - b.fireAt);
}

function listRemindersForNote(ownerId, noteId) {
  const db = load();
  return Object.values(db.reminders)
    .filter((r) => r.ownerId === ownerId && r.noteId === noteId)
    .sort((a, b) => a.fireAt - b.fireAt);
}

function getDueReminders() {
  const db = load();
  const now = Date.now();
  return Object.values(db.reminders).filter((r) => r.fireAt <= now);
}

function createReminder(ownerId, partial) {
  const db = load();
  const id = uid();
  const reminder = {
    id,
    ownerId,
    noteId: partial.noteId,
    noteTitle: partial.noteTitle || "",
    fireAt: partial.fireAt,
    repeat: partial.repeat || false,
    repeatInterval: partial.repeatInterval || null, // ms
    createdAt: Date.now()
  };
  db.reminders[id] = reminder;
  return persist().then(() => reminder);
}

function rescheduleReminder(id, intervalMs) {
  const db = load();
  const r = db.reminders[id];
  if (!r) return Promise.resolve(null);
  r.fireAt = Date.now() + intervalMs;
  return persist().then(() => r);
}

function deleteReminder(id) {
  const db = load();
  if (!db.reminders[id]) return Promise.resolve(false);
  delete db.reminders[id];
  return persist().then(() => true);
}

// ---------- bills (per-user, gated by bills access) ----------
function advanceDueDate(dateStr, frequency) {
  const d = new Date(dateStr + "T00:00:00");
  switch (frequency) {
    case "weekly":    d.setDate(d.getDate() + 7); break;
    case "biweekly":  d.setDate(d.getDate() + 14); break;
    case "monthly":   d.setMonth(d.getMonth() + 1); break;
    case "quarterly": d.setMonth(d.getMonth() + 3); break;
    case "yearly":    d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

function listBills(ownerId) {
  const db = load();
  return Object.values(db.bills)
    .filter((b) => b.ownerId === ownerId)
    .sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return (a.name || "").localeCompare(b.name || "");
    });
}

function getBill(ownerId, id) {
  const db = load();
  const bill = db.bills[id];
  if (!bill || bill.ownerId !== ownerId) return null;
  return bill;
}

function createBill(ownerId, partial) {
  const db = load();
  const id = uid();
  const bill = {
    id,
    ownerId,
    name:         partial.name || "New bill",
    amount:       parseFloat(partial.amount) || 0,
    currency:     partial.currency || "USD",
    dueDate:      partial.dueDate || null,
    frequency:    partial.frequency || "monthly",
    category:     partial.category || "Other",
    autoPay:      Boolean(partial.autoPay),
    url:          partial.url || "",
    color:        partial.color || "#c9605a",
    notes:        partial.notes || "",
    reminderDays: partial.reminderDays != null ? Number(partial.reminderDays) : null,
    paid:         false,
    paidDates:    [],
    createdAt:    Date.now()
  };
  db.bills[id] = bill;
  return persist().then(() => bill);
}

function updateBill(ownerId, id, partial) {
  const db = load();
  const bill = db.bills[id];
  if (!bill || bill.ownerId !== ownerId) return Promise.resolve(null);
  const fields = ["name","amount","currency","dueDate","frequency","category","autoPay","url","color","notes","reminderDays","paid"];
  fields.forEach(f => { if (f in partial) bill[f] = partial[f]; });
  if (typeof bill.amount === "string") bill.amount = parseFloat(bill.amount) || 0;
  return persist().then(() => bill);
}

function markBillPaid(ownerId, id) {
  const db = load();
  const bill = db.bills[id];
  if (!bill || bill.ownerId !== ownerId) return Promise.resolve(null);
  const today = new Date().toISOString().slice(0, 10);
  if (!bill.paidDates) bill.paidDates = [];
  bill.paidDates.unshift(today);
  if (bill.frequency === "one-time") {
    bill.paid = true;
  } else if (bill.dueDate) {
    bill.dueDate = advanceDueDate(bill.dueDate, bill.frequency);
    bill.paid = false;
  }
  return persist().then(() => bill);
}

function markBillUnpaid(ownerId, id) {
  const db = load();
  const bill = db.bills[id];
  if (!bill || bill.ownerId !== ownerId) return Promise.resolve(null);
  bill.paid = false;
  return persist().then(() => bill);
}

function deleteBill(ownerId, id) {
  const db = load();
  const bill = db.bills[id];
  if (!bill || bill.ownerId !== ownerId) return Promise.resolve(false);
  delete db.bills[id];
  return persist().then(() => true);
}

// ---------- allowlist (admin-managed guest list) ----------
function listAllowlist() {
  const db = load();
  return Object.values(db.allowlist).sort((a, b) => a.addedAt - b.addedAt);
}

function addAllowlistEntry(id, label) {
  const db = load();
  id = String(id).trim();
  db.allowlist[id] = { id, label: (label || "").slice(0, 64), addedAt: Date.now() };
  return persist().then(() => db.allowlist[id]);
}

function removeAllowlistEntry(id) {
  const db = load();
  if (!db.allowlist[id]) return Promise.resolve(false);
  delete db.allowlist[id];
  return persist().then(() => true);
}

// ---------- bills access (admin-granted, per user) ----------
function listBillsAccess() {
  const db = load();
  return Object.values(db.billsAccess).sort((a, b) => a.addedAt - b.addedAt);
}

function hasBillsAccess(id) {
  const db = load();
  return !!db.billsAccess[id];
}

function grantBillsAccess(id) {
  const db = load();
  id = String(id).trim();
  db.billsAccess[id] = { id, addedAt: Date.now() };
  return persist().then(() => db.billsAccess[id]);
}

function revokeBillsAccess(id) {
  const db = load();
  if (!db.billsAccess[id]) return Promise.resolve(false);
  delete db.billsAccess[id];
  return persist().then(() => true);
}

module.exports = {
  upsertUser, getUser, updateUserTimezone,
  listCharacters, createCharacter, updateCharacter, deleteCharacter,
  listNotes, getNote, createNote, updateNote, deleteNote, clearNotes,
  listReminders, listRemindersForNote, getDueReminders, createReminder, rescheduleReminder, deleteReminder,
  listBills, getBill, createBill, updateBill, markBillPaid, markBillUnpaid, deleteBill,
  listAllowlist, addAllowlistEntry, removeAllowlistEntry,
  listBillsAccess, hasBillsAccess, grantBillsAccess, revokeBillsAccess
};
