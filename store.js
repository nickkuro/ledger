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
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {}, characters: {}, notes: {} }, null, 2));
  }
}

function load() {
  if (cache) return cache;
  ensureFile();
  cache = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!cache.users) cache.users = {};
  if (!cache.characters) cache.characters = {};
  if (!cache.notes) cache.notes = {};
  return cache;
}

function persist() {
  const data = cache;
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve, reject) => {
        fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
          if (err) reject(err);
          else resolve();
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
  db.users[discordUser.id] = {
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

// ---------- characters ----------
function listCharacters(ownerId) {
  const db = load();
  return Object.values(db.characters)
    .filter((c) => c.ownerId === ownerId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function getCharacter(ownerId, id) {
  const db = load();
  const c = db.characters[id];
  if (!c || c.ownerId !== ownerId) return null;
  return c;
}

function createCharacter(ownerId, partial) {
  const db = load();
  const id = uid();
  const character = {
    id,
    ownerId,
    name: (partial.name || "").slice(0, 64),
    color: partial.color || "#e8a33d",
    createdAt: Date.now()
  };
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
  // Remove all notes belonging to this character
  Object.keys(db.notes).forEach((nid) => {
    if (db.notes[nid].characterId === id && db.notes[nid].ownerId === ownerId) {
      delete db.notes[nid];
    }
  });
  return persist().then(() => true);
}

// ---------- notes ----------
function listNotes(ownerId, characterId) {
  const db = load();
  return Object.values(db.notes).filter((n) => {
    if (n.ownerId !== ownerId) return false;
    if (characterId === "__all__") return true;
    return (n.characterId || null) === (characterId || null);
  });
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
  note.updatedAt = Date.now();
  return persist().then(() => note);
}

function deleteNote(ownerId, id) {
  const db = load();
  const note = db.notes[id];
  if (!note || note.ownerId !== ownerId) return Promise.resolve(false);
  delete db.notes[id];
  return persist().then(() => true);
}

function clearNotes(ownerId, characterId) {
  const db = load();
  Object.keys(db.notes).forEach((id) => {
    const n = db.notes[id];
    if (n.ownerId !== ownerId) return;
    if (characterId === "__all__" || (n.characterId || null) === (characterId || null)) {
      delete db.notes[id];
    }
  });
  return persist();
}

module.exports = {
  upsertUser,
  getUser,
  listCharacters,
  getCharacter,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  clearNotes
};
