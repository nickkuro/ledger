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

  assert.equal(note.spoiler, false, 'a new note should not be a spoiler by default');

  const updated = await store.updateNote(ownerId, note.id, { sticky: true });
  assert.equal(updated.sticky, true);
  assert.strictEqual(typeof updated.sticky, 'boolean', 'sticky should round-trip as a real boolean, not 0/1');
  assert.ok(Array.isArray(updated.tags), 'tags should round-trip as a real array, not a JSON string');
  assert.deepEqual(updated.tags, ['shared']);

  const spoilered = await store.updateNote(ownerId, note.id, { spoiler: true });
  assert.equal(spoilered.spoiler, true);
  assert.strictEqual(typeof spoilered.spoiler, 'boolean', 'spoiler should round-trip as a real boolean, not 0/1');
  assert.equal(spoilered.sticky, true, 'toggling spoiler should leave sticky untouched');
  const unspoilered = await store.updateNote(ownerId, note.id, { spoiler: false });
  assert.equal(unspoilered.spoiler, false, 'spoiler should be clearable');

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

  const otherOwnerId = `store-check-currency-other-${Date.now()}`;
  await store.upsertUser({ id: otherOwnerId, username: 'Other Currency Person', avatar: null });
  await store.createBill(ownerId, { name: 'Rent', amount: 1200, currency: 'USD', dueDate: '2026-09-01', frequency: 'monthly' });
  await store.createBill(ownerId, { name: 'Internet', amount: 60, currency: 'CAD', dueDate: '2026-09-05', frequency: 'monthly' });
  const otherBill = await store.createBill(otherOwnerId, { name: 'Someone else\'s bill', amount: 20, currency: 'USD', dueDate: '2026-09-10', frequency: 'monthly' });

  await assert.rejects(
    () => store.updateAllBillsCurrency(ownerId, 'DOGE'),
    /Invalid currency/,
    'cascading an unrecognized currency code should be rejected'
  );

  const billsUpdated = await store.updateAllBillsCurrency(ownerId, 'GBP');
  assert.equal(billsUpdated, 2, 'should report the number of bills relabeled');
  const ownerBills = await store.listBills(ownerId);
  assert.ok(ownerBills.every((b) => b.currency === 'GBP'), 'every one of this owner\'s bills should now show the new currency');
  const untouchedOther = await store.listBills(otherOwnerId);
  assert.equal(untouchedOther.find((b) => b.id === otherBill.id).currency, 'USD', 'another owner\'s bills should be untouched by the cascade');
}

async function checkBillCategories() {
  const ownerId = `store-check-categories-${Date.now()}`;
  const user = await store.upsertUser({ id: ownerId, username: 'Category Person', avatar: null });
  assert.deepEqual(
    user.billCategories,
    ['Housing', 'Utilities', 'Entertainment', 'Insurance', 'Subscriptions', 'Food', 'Transport', 'Health', 'Savings', 'Other'],
    'a brand new user should get the built-in default category list'
  );

  await assert.rejects(
    () => store.updateBillCategories(ownerId, []),
    /At least one category/,
    'an empty category list should be rejected'
  );
  await assert.rejects(
    () => store.updateBillCategories(ownerId, 'not an array'),
    /must be a list/,
    'a non-array categories value should be rejected'
  );

  const updated = await store.updateBillCategories(ownerId, ['Rent', ' Groceries ', 'rent', 'RENT', '']);
  assert.deepEqual(updated.billCategories, ['Rent', 'Groceries'], 'should trim whitespace, drop blanks, and dedupe case-insensitively');
  assert.deepEqual(store.getUser(ownerId).billCategories, ['Rent', 'Groceries'], 'the change should persist');
}

async function checkTrashSoftDelete() {
  const ownerId = `store-check-trash-${Date.now()}`;
  const otherId = `store-check-trash-other-${Date.now()}`;
  await store.upsertUser({ id: ownerId, username: 'Trash Person', avatar: null });
  await store.upsertUser({ id: otherId, username: 'Other Trash Person', avatar: null });

  const note = await store.createNote(ownerId, { title: 'Doomed note', body: 'body' });
  const bill = await store.createBill(ownerId, { name: 'Doomed bill', amount: 12, dueDate: '2026-10-01', frequency: 'monthly' });

  await store.deleteNote(ownerId, note.id);
  await store.deleteBill(ownerId, bill.id);

  // Gone from the normal views...
  assert.ok(!(await store.listNotes(ownerId, '__all__')).some((n) => n.id === note.id), 'a deleted note should leave the notes list');
  assert.equal(store.getNote(ownerId, note.id), null, 'a deleted note should not be fetchable');
  assert.ok(!store.listBills(ownerId).some((b) => b.id === bill.id), 'a deleted bill should leave the bills list');
  assert.ok(!store.getAllBills().some((b) => b.id === bill.id), 'a deleted bill should not reach the reminder job');

  // ...but present in the trash.
  const trash = store.listTrash(ownerId);
  assert.ok(trash.notes.some((n) => n.id === note.id), 'the deleted note should be in the trash');
  assert.ok(trash.bills.some((b) => b.id === bill.id), 'the deleted bill should be in the trash');

  // Another owner can neither see nor act on it.
  const otherTrash = store.listTrash(otherId);
  assert.equal(otherTrash.notes.length, 0, "another owner's trash should be empty");
  assert.equal(await store.restoreFromTrash(otherId, 'note', note.id), false, 'another owner should not be able to restore it');
  assert.equal(await store.deleteFromTrashPermanently(otherId, 'note', note.id), false, 'another owner should not be able to purge it');

  // Restore brings it back intact.
  assert.equal(await store.restoreFromTrash(ownerId, 'note', note.id), true);
  const restored = store.getNote(ownerId, note.id);
  assert.ok(restored, 'the restored note should be fetchable again');
  assert.equal(restored.title, 'Doomed note', 'restore should preserve content');
  assert.equal(restored.deletedAt, null, 'a restored note should no longer be marked deleted');

  // Permanent delete really removes it.
  await store.deleteNote(ownerId, note.id);
  assert.equal(await store.deleteFromTrashPermanently(ownerId, 'note', note.id), true);
  assert.equal(store.listTrash(ownerId).notes.length, 0, 'a permanently deleted note should leave the trash');

  // Purge only takes items past the retention window.
  const fresh = await store.createNote(ownerId, { title: 'Recently binned', body: 'x' });
  await store.deleteNote(ownerId, fresh.id);
  await store.purgeExpiredTrash(30);
  assert.ok(store.listTrash(ownerId).notes.some((n) => n.id === fresh.id), 'a just-deleted note should survive a 30-day purge');
  await store.purgeExpiredTrash(0);
  assert.ok(!store.listTrash(ownerId).notes.some((n) => n.id === fresh.id), 'a zero-day purge should clear it');

  await store.emptyTrash(ownerId);
  await store.deleteAllUserData(ownerId);
  await store.deleteAllUserData(otherId);
}

async function checkImport() {
  const ownerId = `store-check-import-${Date.now()}`;
  await store.upsertUser({ id: ownerId, username: 'Import Person', avatar: null });

  // A file shaped like an export, with IDs that must not survive verbatim and
  // an ownerId that must be ignored in favour of the importing account.
  const file = {
    characters: [{ id: 'old-char-1', name: 'Alpha', color: '#e8a33d', ownerId: 'someone-else' }],
    notes: [
      { id: 'old-note-1', title: 'Imported note', body: 'hello', tags: ['x'], characterId: 'old-char-1', ownerId: 'someone-else' },
      { id: 'old-note-2', title: 'Loose note', body: 'no character', characterId: null }
    ],
    bills: [{ id: 'old-bill-1', name: 'Imported bill', amount: 42, dueDate: '2026-11-01', frequency: 'monthly', paid: true, paidDates: ['2026-10-01'] }]
  };

  const firstPass = store.analyzeImport(ownerId, file);
  assert.deepEqual(firstPass.counts, { characters: 1, notes: 2, bills: 1 });
  assert.equal(firstPass.duplicates.length, 0, 'nothing should look like a duplicate on a fresh account');

  const imported = await store.importData(ownerId, file, []);
  assert.deepEqual(imported, { characters: 1, notes: 2, bills: 1, skipped: 0 });

  const chars = store.listCharacters(ownerId);
  const notes = store.listNotes(ownerId, '__all__');
  const bills = store.listBills(ownerId);
  assert.equal(chars.length, 1);
  assert.notEqual(chars[0].id, 'old-char-1', 'imported IDs should be regenerated, never reused');
  assert.equal(chars[0].ownerId, ownerId, 'imported rows belong to the importing account');

  const linked = notes.find((n) => n.title === 'Imported note');
  assert.equal(linked.characterId, chars[0].id, "a note's character link should be remapped to the new character id");
  assert.notEqual(linked.id, 'old-note-1', 'note IDs should be regenerated too');
  assert.equal(linked.ownerId, ownerId);
  assert.equal(notes.find((n) => n.title === 'Loose note').characterId, null);

  assert.equal(bills[0].paid, true, 'imported bills keep their paid state');
  assert.deepEqual(bills[0].paidDates, ['2026-10-01'], 'imported bills keep their payment history');

  // Re-analyzing the same file now flags everything as a duplicate.
  const secondPass = store.analyzeImport(ownerId, file);
  assert.equal(secondPass.duplicates.length, 4, 'a re-import should flag all four entries as duplicates');
  assert.ok(secondPass.duplicates.some((d) => d.type === 'character' && d.label === 'Alpha'));
  assert.ok(secondPass.duplicates.some((d) => d.type === 'bill' && d.label === 'Imported bill'));

  // Skipping every duplicate imports nothing new, and the skipped character
  // still resolves so notes would attach to the existing one.
  const skipAll = await store.importData(ownerId, file, secondPass.duplicates.map((d) => d.key));
  assert.deepEqual(skipAll, { characters: 0, notes: 0, bills: 0, skipped: 4 });
  assert.equal(store.listCharacters(ownerId).length, 1, 'skipping duplicates should not create anything');
  assert.equal(store.listNotes(ownerId, '__all__').length, 2, 'skipping duplicates should leave note count unchanged');

  // Importing anyway (no skips) duplicates them rather than overwriting.
  await store.importData(ownerId, file, []);
  assert.equal(store.listNotes(ownerId, '__all__').length, 4, 'importing without skipping should add copies, not overwrite');

  // Malformed input is tolerated rather than throwing.
  assert.deepEqual(store.analyzeImport(ownerId, {}).counts, { characters: 0, notes: 0, bills: 0 });
  assert.deepEqual(await store.importData(ownerId, { notes: 'not an array' }, []), { characters: 0, notes: 0, bills: 0, skipped: 0 });

  await store.deleteAllUserData(ownerId);
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
  await checkBillCategories();
  await checkTrashSoftDelete();
  await checkImport();
  console.log('Store check passed.');
}

runStoreCheck().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
