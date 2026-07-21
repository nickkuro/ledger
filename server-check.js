// Route-level smoke tests for the Express app. These exercise the auth guards
// and cross-user ownership enforcement end to end -- the checks that matter
// most if a route is ever added without requireAuth or a store lookup forgets
// its ownerId filter. Run with `node --test server-check.js`.
//
// The app is booted on an ephemeral port against a throwaway data directory
// (LEDGER_DATA_DIR) so nothing here touches the real database. Real sessions
// are obtained through the local-login flow rather than being faked, so the
// session/cookie plumbing is covered too.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Must be set before requiring store/server -- both read env at load time.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
process.env.LEDGER_DATA_DIR = TMP_DIR;
process.env.DISCORD_CLIENT_ID = "test-client";
process.env.DISCORD_CLIENT_SECRET = "test-secret";
process.env.DISCORD_REDIRECT_URI = "http://localhost/auth/discord/callback";
process.env.SESSION_SECRET = "test-session-secret";
delete process.env.NODE_ENV; // keep cookies non-secure so http works

const store = require("./store");
const app = require("./server");

let server;
let base;

function firstCookie(res) {
  const cookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")].filter(Boolean);
  if (!cookies.length) return null;
  return cookies[0].split(";")[0]; // "connect.sid=..." without attributes
}

async function req(method, urlPath, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual"
  });
  let json = null;
  try { json = await res.json(); } catch { /* not all responses are JSON */ }
  return { status: res.status, json, cookie: firstCookie(res) };
}

async function loginAs(username, password) {
  await store.createLocalAccount(username, password);
  const res = await req("POST", "/auth/local-login", { body: { username, password } });
  assert.equal(res.status, 200, `login for ${username} should succeed`);
  assert.ok(res.cookie, `login for ${username} should set a session cookie`);
  return res.cookie;
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  // Best-effort: the SQLite handle stays open until the process exits, so on
  // Windows the file can't be unlinked yet. The OS reclaims its temp dir; a
  // failed cleanup here shouldn't fail the suite.
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ignore */ }
});

test("health check is public", async () => {
  const res = await fetch(base + "/healthz");
  assert.equal(res.status, 200);
});

test("security headers are present on responses", async () => {
  const res = await fetch(base + "/healthz");
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp, "a Content-Security-Policy header should be set");
  assert.match(csp, /script-src 'self'/, "scripts should be restricted to self");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("unauthenticated API access is rejected", async () => {
  assert.equal((await req("GET", "/api/me")).status, 401);
  assert.equal((await req("GET", "/api/notes")).status, 401);
  assert.equal((await req("POST", "/api/notes", { body: { title: "x" } })).status, 401);
  assert.equal((await req("GET", "/api/bills")).status, 401);
});

test("admin routes reject unauthenticated and non-admin callers", async () => {
  assert.equal((await req("GET", "/api/admin/allowlist")).status, 401);
  const userCookie = await loginAs("alice_admincheck", "correcthorsebattery");
  assert.equal((await req("GET", "/api/admin/allowlist", { cookie: userCookie })).status, 403);
});

test("a logged-in user can create and read their own note", async () => {
  const cookie = await loginAs("alice_notes", "correcthorsebattery");
  const created = await req("POST", "/api/notes", { cookie, body: { title: "Alice note", body: "secret" } });
  assert.equal(created.status, 201);
  assert.ok(created.json.id);

  const list = await req("GET", "/api/notes", { cookie });
  assert.equal(list.status, 200);
  assert.ok(list.json.some((n) => n.id === created.json.id), "own note should appear in the list");
});

test("import previews duplicates, respects skips, and ignores ownerId in the file", async () => {
  const aliceCookie = await loginAs("alice_import", "correcthorsebattery");
  const bobCookie = await loginAs("bob_importvictim", "correcthorsebattery");

  // The file claims to belong to Bob; it must land in Alice's account anyway.
  const file = {
    characters: [],
    notes: [{ id: "spoofed", title: "Imported", body: "content", ownerId: "bob_importvictim" }],
    bills: []
  };

  const preview = await req("POST", "/api/import/preview", { cookie: aliceCookie, body: { data: file } });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.counts.notes, 1);
  assert.equal(preview.json.duplicates.length, 0);

  const done = await req("POST", "/api/import", { cookie: aliceCookie, body: { data: file, skip: [] } });
  assert.equal(done.status, 200);
  assert.equal(done.json.notes, 1);

  const aliceNotes = await req("GET", "/api/notes", { cookie: aliceCookie });
  const landed = aliceNotes.json.find((n) => n.title === "Imported");
  assert.ok(landed, "the note should land in the importing account");
  assert.notEqual(landed.id, "spoofed", "the id in the file must not be reused");

  const bobNotes = await req("GET", "/api/notes", { cookie: bobCookie });
  assert.ok(!bobNotes.json.some((n) => n.title === "Imported"), "the ownerId in the file must not place data in another account");

  // Re-previewing now flags it, and skipping it imports nothing.
  const second = await req("POST", "/api/import/preview", { cookie: aliceCookie, body: { data: file } });
  assert.equal(second.json.duplicates.length, 1, "a re-import should flag the note as a duplicate");
  const skipped = await req("POST", "/api/import", { cookie: aliceCookie, body: { data: file, skip: second.json.duplicates.map((d) => d.key) } });
  assert.deepEqual(skipped.json, { characters: 0, notes: 0, bills: 0, skipped: 1 });
});

test("import rejects unauthenticated callers and junk payloads", async () => {
  assert.equal((await req("POST", "/api/import", { body: { data: {} } })).status, 401);
  assert.equal((await req("POST", "/api/import/preview", { body: { data: {} } })).status, 401);
  const cookie = await loginAs("alice_importjunk", "correcthorsebattery");
  assert.equal((await req("POST", "/api/import", { cookie, body: { data: "nonsense" } })).status, 400);
  assert.equal((await req("POST", "/api/import/preview", { cookie, body: {} })).status, 400);
});

test("deleting a note moves it to the trash and it can be restored", async () => {
  const cookie = await loginAs("alice_trash", "correcthorsebattery");
  const created = await req("POST", "/api/notes", { cookie, body: { title: "Trash me", body: "content" } });
  const noteId = created.json.id;

  assert.equal((await req("DELETE", "/api/notes/" + noteId, { cookie })).status, 200);

  const afterDelete = await req("GET", "/api/notes", { cookie });
  assert.ok(!afterDelete.json.some((n) => n.id === noteId), "a deleted note should leave the active list");

  const trash = await req("GET", "/api/trash", { cookie });
  assert.equal(trash.status, 200);
  assert.ok(trash.json.notes.some((n) => n.id === noteId), "the note should be in the trash");

  assert.equal((await req("POST", `/api/trash/note/${noteId}/restore`, { cookie })).status, 200);
  const afterRestore = await req("GET", "/api/notes", { cookie });
  const back = afterRestore.json.find((n) => n.id === noteId);
  assert.ok(back, "the restored note should be back in the active list");
  assert.equal(back.title, "Trash me", "restore should preserve content");
});

test("a user cannot see or act on another user's trashed items", async () => {
  const aliceCookie = await loginAs("alice_trashowner", "correcthorsebattery");
  const created = await req("POST", "/api/notes", { cookie: aliceCookie, body: { title: "Alice trashed", body: "secret" } });
  const noteId = created.json.id;
  await req("DELETE", "/api/notes/" + noteId, { cookie: aliceCookie });

  const bobCookie = await loginAs("bob_trashsnoop", "correcthorsebattery");
  const bobTrash = await req("GET", "/api/trash", { cookie: bobCookie });
  assert.ok(!bobTrash.json.notes.some((n) => n.id === noteId), "Bob should not see Alice's trashed note");

  assert.equal((await req("POST", `/api/trash/note/${noteId}/restore`, { cookie: bobCookie })).status, 404, "Bob should not be able to restore it");
  assert.equal((await req("DELETE", `/api/trash/note/${noteId}`, { cookie: bobCookie })).status, 404, "Bob should not be able to purge it");

  // Still recoverable by its actual owner.
  assert.equal((await req("POST", `/api/trash/note/${noteId}/restore`, { cookie: aliceCookie })).status, 200);
});

test("a user cannot read, edit, or delete another user's note", async () => {
  const aliceCookie = await loginAs("alice_owner", "correcthorsebattery");
  const created = await req("POST", "/api/notes", { cookie: aliceCookie, body: { title: "Alice private", body: "top secret" } });
  assert.equal(created.status, 201);
  const noteId = created.json.id;

  const bobCookie = await loginAs("bob_intruder", "correcthorsebattery");

  const bobList = await req("GET", "/api/notes", { cookie: bobCookie });
  assert.ok(!bobList.json.some((n) => n.id === noteId), "Bob should not see Alice's note in his list");

  assert.equal((await req("PUT", "/api/notes/" + noteId, { cookie: bobCookie, body: { title: "hijacked" } })).status, 404, "Bob should not be able to edit Alice's note");
  assert.equal((await req("DELETE", "/api/notes/" + noteId, { cookie: bobCookie })).status, 404, "Bob should not be able to delete Alice's note");

  // Alice's note is untouched.
  const aliceList = await req("GET", "/api/notes", { cookie: aliceCookie });
  const stillThere = aliceList.json.find((n) => n.id === noteId);
  assert.ok(stillThere, "Alice's note should still exist");
  assert.equal(stillThere.title, "Alice private", "Alice's note title should be unchanged");
});
