const assert = require('node:assert/strict');
const store = require('./store');

async function checkNotesAndCharacters() {
  const ownerId = `store-check-${Date.now()}`;
  const characterA = await store.createCharacter(ownerId, { name: 'Alpha', color: '#e8a33d' });
  const characterB = await store.createCharacter(ownerId, { name: 'Beta', color: '#4fa8a0' });

  const note = await store.createNote(ownerId, {
    title: 'Pinned reminder',
    body: 'Visible everywhere',
    tags: ['shared'],
    characterId: characterA.id
  });

  const updated = await store.updateNote(ownerId, note.id, { sticky: true });
  assert.equal(updated.sticky, true);
  assert.strictEqual(typeof updated.sticky, 'boolean', 'sticky should round-trip as a real boolean, not 0/1');
  assert.ok(Array.isArray(updated.tags), 'tags should round-trip as a real array, not a JSON string');
  assert.deepEqual(updated.tags, ['shared']);

  const visibleNotes = await store.listNotes(ownerId, characterB.id);
  const found = visibleNotes.find((item) => item.id === note.id);
  assert.ok(found, 'sticky note should be visible when viewing a different character');

  await store.deleteNote(ownerId, note.id);
  await store.deleteCharacter(ownerId, characterA.id);
  await store.deleteCharacter(ownerId, characterB.id);
}

async function checkReminderOwnership() {
  const ownerA = `store-check-a-${Date.now()}`;
  const ownerB = `store-check-b-${Date.now()}`;

  const note = await store.createNote(ownerA, { title: 'Reminder target' });
  const reminder = await store.createReminder(ownerA, { noteId: note.id, fireAt: Date.now() + 60000 });

  const stolen = await store.deleteReminder(ownerB, reminder.id);
  assert.equal(stolen, false, 'a different owner must not be able to delete someone else\'s reminder');

  const stillThere = (await store.listReminders(ownerA)).find((r) => r.id === reminder.id);
  assert.ok(stillThere, 'reminder should still exist after a blocked cross-owner delete');

  const removed = await store.deleteReminder(ownerA, reminder.id);
  assert.equal(removed, true, 'the actual owner should be able to delete their own reminder');

  await store.deleteNote(ownerA, note.id);
}

async function checkBillOwnershipAndDueDateRollover() {
  const ownerA = `store-check-bills-a-${Date.now()}`;
  const ownerB = `store-check-bills-b-${Date.now()}`;

  const bill = await store.createBill(ownerA, {
    name: 'Rent', amount: 1200, currency: 'USD', dueDate: '2026-01-31', frequency: 'monthly'
  });

  assert.equal((await store.listBills(ownerB)).length, 0, 'another owner should not see this bill');
  assert.equal(await store.getBill(ownerB, bill.id), null, 'another owner should not be able to fetch this bill by id');
  assert.equal(await store.updateBill(ownerB, bill.id, { name: 'Hijacked' }), null, 'another owner should not be able to update this bill');
  assert.equal(await store.deleteBill(ownerB, bill.id), false, 'another owner should not be able to delete this bill');

  // Jan 31 + 1 month should land on Feb 28 (non-leap year), not overflow into March.
  const paid = await store.markBillPaid(ownerA, bill.id);
  assert.equal(paid.dueDate, '2026-02-28', 'monthly due date should clamp to the end of a shorter month, not roll into the next one');

  await store.deleteBill(ownerA, bill.id);
}

async function checkBillPriorityColorAndSorting() {
  const ownerId = `store-check-priority-${Date.now()}`;

  const fresh = await store.createBill(ownerId, { name: 'Water', amount: 40, currency: 'USD', dueDate: '2026-08-01', frequency: 'monthly' });
  assert.equal(fresh.priority, 'medium', 'a bill created with no priority should default to medium');

  const urgent = await store.updateBill(ownerId, fresh.id, { priority: 'urgent' });
  assert.equal(urgent.priority, 'urgent');
  assert.equal(urgent.color, '#c9605a', 'color should be recomputed to match the chosen priority');

  const rejected = await store.updateBill(ownerId, fresh.id, { priority: 'not-a-real-priority' });
  assert.equal(rejected.priority, 'urgent', 'an invalid priority value should be ignored, keeping the last valid one');

  // Two bills sharing the same due date should sort by priority (higher first) as a tiebreak.
  const sameDayLow = await store.createBill(ownerId, { name: 'Low prio same day', amount: 5, dueDate: '2026-09-01', frequency: 'monthly', priority: 'low' });
  const sameDayUrgent = await store.createBill(ownerId, { name: 'Urgent same day', amount: 5, dueDate: '2026-09-01', frequency: 'monthly', priority: 'urgent' });
  const listed = await store.listBills(ownerId);
  const sameDayIds = listed.filter((b) => b.dueDate === '2026-09-01').map((b) => b.id);
  assert.deepEqual(sameDayIds, [sameDayUrgent.id, sameDayLow.id], 'urgent bill should sort before a low-priority bill sharing the same due date');

  await store.deleteBill(ownerId, fresh.id);
  await store.deleteBill(ownerId, sameDayLow.id);
  await store.deleteBill(ownerId, sameDayUrgent.id);
}

async function checkNotePreviousVersionRestore() {
  const ownerA = `store-check-restore-a-${Date.now()}`;
  const ownerB = `store-check-restore-b-${Date.now()}`;

  const note = await store.createNote(ownerA, { title: 'v1', body: 'body v1' });
  const fresh = await store.getNote(ownerA, note.id);
  assert.equal(fresh.prevBody, null, 'a brand new note should have no previous version yet');

  await store.updateNote(ownerA, note.id, { title: 'v2', body: 'body v2' });
  const afterAccidentalPaste = await store.updateNote(ownerA, note.id, { title: 'v3', body: 'PASTED OVER' });
  assert.equal(afterAccidentalPaste.prevBody, 'body v2', 'previous version should be the content right before the last save');
  assert.equal(afterAccidentalPaste.prevTitle, 'v2');

  assert.equal(await store.restorePreviousVersion(ownerB, note.id), null, 'another owner must not be able to restore this note');

  const restored = await store.restorePreviousVersion(ownerA, note.id);
  assert.equal(restored.body, 'body v2', 'restore should bring back the version saved before the last one');
  assert.equal(restored.prevBody, 'PASTED OVER', 'restore itself should be undoable by swapping the pasted-over content into prev');

  const restoredAgain = await store.restorePreviousVersion(ownerA, note.id);
  assert.equal(restoredAgain.body, 'PASTED OVER', 'restoring twice should bring back the pasted-over content (undo the undo)');

  await store.deleteNote(ownerA, note.id);
}

async function checkAllowlistAndBillsAccess() {
  const id = `store-check-guest-${Date.now()}`;

  const entry = await store.addAllowlistEntry(id, 'Test guest');
  assert.ok((await store.listAllowlist()).some((e) => e.id === id), 'added allowlist entry should be listed');
  assert.equal(entry.label, 'Test guest');
  await store.removeAllowlistEntry(id);
  assert.ok(!(await store.listAllowlist()).some((e) => e.id === id), 'removed allowlist entry should no longer be listed');

  assert.equal(store.hasBillsAccess(id), false);
  await store.grantBillsAccess(id);
  assert.equal(store.hasBillsAccess(id), true);
  await store.revokeBillsAccess(id);
  assert.equal(store.hasBillsAccess(id), false);
}

async function checkDeleteAllUserData() {
  const ownerA = `store-check-wipe-a-${Date.now()}`;
  const ownerB = `store-check-wipe-b-${Date.now()}`;

  await store.upsertUser({ id: ownerA, username: 'Wipe Me', avatar: null });
  await store.updateUserTimezone(ownerA, 'America/New_York');
  await store.updateUserIncome(ownerA, 4200, 'USD');

  const character = await store.createCharacter(ownerA, { name: 'Doomed', color: '#c9605a' });
  const note = await store.createNote(ownerA, { title: 'Gone soon', body: 'bye', characterId: character.id });
  await store.createReminder(ownerA, { noteId: note.id, fireAt: Date.now() + 60000 });
  const bill = await store.createBill(ownerA, { name: 'Doomed bill', amount: 10, dueDate: '2026-09-01', frequency: 'monthly' });

  const otherCharacter = await store.createCharacter(ownerB, { name: 'Safe', color: '#4fa8a0' });
  const otherNote = await store.createNote(ownerB, { title: 'Should survive', body: 'still here', characterId: otherCharacter.id });

  await store.deleteAllUserData(ownerA);

  assert.deepEqual(await store.listCharacters(ownerA), [], 'characters should be wiped');
  assert.deepEqual(await store.listNotes(ownerA, '__all__'), [], 'notes should be wiped');
  assert.deepEqual(await store.listReminders(ownerA), [], 'reminders should be wiped');
  assert.deepEqual(await store.listBills(ownerA), [], 'bills should be wiped');

  const wipedUser = store.getUser(ownerA);
  assert.equal(wipedUser.timezone, null, 'timezone preference should be reset');
  assert.equal(wipedUser.incomeEstimate, null, 'income estimate should be reset');
  assert.equal(wipedUser.incomeCurrency, null, 'income currency should be reset');

  assert.ok((await store.listCharacters(ownerB)).some((c) => c.id === otherCharacter.id), 'another owner\'s characters must survive');
  assert.ok((await store.listNotes(ownerB, '__all__')).some((n) => n.id === otherNote.id), 'another owner\'s notes must survive');

  await store.deleteCharacter(ownerB, otherCharacter.id);
}

async function checkLocalAccounts() {
  const username = `store-check-local-${Date.now()}`;

  const account = await store.createLocalAccount(username, 'correcthorsebattery');
  assert.equal(account.authType, 'local');
  assert.equal(account.mustChangePassword, true, 'a freshly created account should require a password change');
  assert.ok(account.id.startsWith('local_'), 'local account ids should be clearly non-numeric, unlike Discord snowflakes');

  // Duplicate username (case-insensitive) must be rejected.
  await assert.rejects(
    () => store.createLocalAccount(username.toUpperCase(), 'whatever123'),
    /already taken/,
    'duplicate usernames (case-insensitive) should be rejected'
  );

  assert.equal(store.verifyLocalLogin(username, 'wrongpassword'), null, 'wrong password should not authenticate');
  assert.ok(store.verifyLocalLogin(username, 'correcthorsebattery'), 'correct password should authenticate');
  assert.ok(store.verifyLocalLogin(username.toUpperCase(), 'correcthorsebattery'), 'username lookup should be case-insensitive');

  assert.equal(await store.changeOwnPassword(account.id, 'wrongpassword', 'newpassword1'), false, 'changing with the wrong current password should fail');
  assert.equal(await store.changeOwnPassword(account.id, 'correcthorsebattery', 'newpassword1'), true);
  assert.equal(store.getUser(account.id).mustChangePassword, false, 'self-service password change should clear the forced-change flag');
  assert.ok(store.verifyLocalLogin(username, 'newpassword1'), 'login should work with the newly chosen password');
  assert.equal(store.verifyLocalLogin(username, 'correcthorsebattery'), null, 'the old password should no longer work');

  const reset = await store.adminResetPassword(account.id, 'temp12345');
  assert.equal(reset.mustChangePassword, true, 'an admin-triggered reset should re-require a password change');
  assert.ok(store.verifyLocalLogin(username, 'temp12345'), 'login should work with the admin-reset password');

  // Give the account some data, then confirm deleting it wipes both the data and the account itself.
  const character = await store.createCharacter(account.id, { name: 'Temp', color: '#c9605a' });
  await store.createNote(account.id, { title: 'Temp note', body: 'x', characterId: character.id });
  assert.equal(await store.deleteLocalAccount(account.id), true);
  assert.equal(store.getUser(account.id), null, 'the account row itself should be gone after deletion (unlike the Discord "remove my data" flow)');
  assert.deepEqual(await store.listNotes(account.id, '__all__'), [], 'notes should be wiped along with the account');
  assert.equal(await store.deleteLocalAccount(account.id), false, 'deleting an already-deleted account should be a no-op, not throw');
}

async function checkIcalTokenAndDigest() {
  const ownerId = `store-check-ical-${Date.now()}`;
  await store.upsertUser({ id: ownerId, username: 'Ical Person', avatar: null });

  const token1 = await store.getOrCreateIcalToken(ownerId);
  assert.ok(token1 && token1.length > 20, 'a real token should be generated');
  const token1Again = await store.getOrCreateIcalToken(ownerId);
  assert.equal(token1Again, token1, 'repeat calls should return the same stable token, not regenerate');

  const token2 = await store.regenerateIcalToken(ownerId);
  assert.notEqual(token2, token1, 'regenerating should produce a different token');

  const resolved = store.getUserByIcalToken(token2);
  assert.equal(resolved.id, ownerId, 'the new token should resolve back to the right user');
  assert.equal(store.getUserByIcalToken(token1), null, 'the old (regenerated-away) token should no longer resolve');
  assert.equal(store.getUserByIcalToken('not-a-real-token'), null, 'a bogus token should resolve to nothing');

  await assert.rejects(
    () => store.updateDigestFrequency(ownerId, 'hourly'),
    /Invalid digest frequency/,
    'an unrecognized frequency should be rejected'
  );
  const updated = await store.updateDigestFrequency(ownerId, 'daily');
  assert.equal(updated.digestFrequency, 'daily');

  const enabled = store.listUsersWithDigestEnabled();
  assert.ok(enabled.some((u) => u.id === ownerId), 'an opted-in Discord account should be listed');

  await store.updateDigestFrequency(ownerId, 'off');
  assert.ok(!store.listUsersWithDigestEnabled().some((u) => u.id === ownerId), 'turning digest off should remove it from the list');

  // A local account should never show up here even if somehow flagged -- listUsersWithDigestEnabled is authType='discord' only.
  const localAcct = await store.createLocalAccount(`store-check-ical-local-${Date.now()}`, 'correcthorsebattery12');
  assert.ok(!store.listUsersWithDigestEnabled().some((u) => u.id === localAcct.id), 'local accounts should never receive Discord digests');
  await store.deleteLocalAccount(localAcct.id);

  assert.equal(store.getUser(ownerId).lastLoginAt, null, 'a user who has never logged in should have no lastLoginAt');
  await store.recordLogin(ownerId);
  assert.ok(store.getUser(ownerId).lastLoginAt > 0, 'recordLogin should set lastLoginAt');
}

async function checkDefaultCurrency() {
  const ownerId = `store-check-currency-${Date.now()}`;
  const user = await store.upsertUser({ id: ownerId, username: 'Currency Person', avatar: null });
  assert.equal(user.defaultCurrency, 'USD', 'a brand new user should default to USD');

  await assert.rejects(
    () => store.updateDefaultCurrency(ownerId, 'DOGE'),
    /Invalid currency/,
    'an unrecognized currency code should be rejected'
  );

  const updated = await store.updateDefaultCurrency(ownerId, 'EUR');
  assert.equal(updated.defaultCurrency, 'EUR');
  assert.equal(store.getUser(ownerId).defaultCurrency, 'EUR', 'the change should persist');
}

async function runStoreCheck() {
  await checkNotesAndCharacters();
  await checkReminderOwnership();
  await checkNotePreviousVersionRestore();
  await checkBillOwnershipAndDueDateRollover();
  await checkBillPriorityColorAndSorting();
  await checkAllowlistAndBillsAccess();
  await checkDeleteAllUserData();
  await checkLocalAccounts();
  await checkIcalTokenAndDigest();
  await checkDefaultCurrency();
  console.log('Store check passed.');
}

runStoreCheck().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
