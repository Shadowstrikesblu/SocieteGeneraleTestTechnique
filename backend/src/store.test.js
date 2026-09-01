'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('./store');

// The store is a stateful module, so these tests reason in relative changes
// rather than absolute values. Asserting "balance is 284732" would make every
// test depend on the order the others ran in.

test('createTransfer debits the account and records the operation', () => {
  const before = store.findAccount('courant').balanceCents;
  const countBefore = store.listTransactions('courant').length;

  const result = store.createTransfer({
    fromAccountId: 'courant',
    beneficiaryId: 'b1',
    amountCents: 1500
  });

  assert.equal(result.error, undefined);
  assert.equal(store.findAccount('courant').balanceCents, before - 1500);
  assert.equal(result.transaction.accountId, 'courant');
  // Debits are stored negative: the sign carries the direction, so the
  // listing never has to know which side of the transfer it is looking at.
  assert.equal(result.transaction.amountCents, -1500);
  assert.equal(store.listTransactions('courant').length, countBefore + 1);
});

test('an insufficient balance is rejected with no mutation at all', () => {
  const before = store.findAccount('courant').balanceCents;
  const countBefore = store.listTransactions('courant').length;

  const result = store.createTransfer({
    fromAccountId: 'courant',
    beneficiaryId: 'b1',
    amountCents: before + 1
  });

  assert.equal(result.error, 'insufficient_funds');
  // The point of the whole test file: a rejected transfer must leave no
  // partial write behind — neither a debited balance nor an orphan operation.
  assert.equal(store.findAccount('courant').balanceCents, before);
  assert.equal(store.listTransactions('courant').length, countBefore);
});

test('a transfer of exactly the whole balance is allowed', () => {
  const account = store.findAccount('titres');
  const before = account.balanceCents;

  const result = store.createTransfer({
    fromAccountId: 'titres',
    beneficiaryId: 'b1',
    amountCents: before
  });

  // The boundary is "greater than balance", not "greater than or equal":
  // emptying an account is legitimate, and an off-by-one here would reject it.
  assert.equal(result.error, undefined);
  assert.equal(store.findAccount('titres').balanceCents, 0);
});

test('non-integer, zero and negative amounts are rejected', () => {
  const before = store.findAccount('courant').balanceCents;
  const countBefore = store.listTransactions('courant').length;

  // 12.5 matters most: cents are integers, so a fractional amount means euros
  // leaked in from the edge of the system and float arithmetic is about to
  // start rounding balances.
  for (const amountCents of [0, -100, 12.5, NaN, undefined, null, '1500']) {
    const result = store.createTransfer({
      fromAccountId: 'courant',
      beneficiaryId: 'b1',
      amountCents
    });
    assert.equal(result.error, 'invalid_amount', `should reject: ${String(amountCents)}`);
  }

  assert.equal(store.findAccount('courant').balanceCents, before);
  assert.equal(store.listTransactions('courant').length, countBefore);
});

test('unknown account and unknown beneficiary are told apart', () => {
  // Two distinct codes, because "which of the two is wrong" is exactly what
  // the caller needs to know and a generic 400 would hide.
  assert.equal(
    store.createTransfer({ fromAccountId: 'nope', beneficiaryId: 'b1', amountCents: 100 }).error,
    'unknown_account'
  );

  assert.equal(
    store.createTransfer({ fromAccountId: 'courant', beneficiaryId: 'nope', amountCents: 100 }).error,
    'unknown_beneficiary'
  );
});

test('identity is checked before the amount', () => {
  // An unknown account with an invalid amount must report the account, not the
  // amount: validating in this order means the caller fixes the real problem
  // first instead of chasing a second error after correcting the first.
  const result = store.createTransfer({
    fromAccountId: 'nope',
    beneficiaryId: 'b1',
    amountCents: -1
  });

  assert.equal(result.error, 'unknown_account');
});

test('listTransactions filters by account and returns newest first', () => {
  const all = store.listTransactions();
  const courant = store.listTransactions('courant');

  assert.ok(courant.length > 0);
  assert.ok(courant.every((t) => t.accountId === 'courant'));
  assert.ok(all.length >= courant.length);

  const dates = all.map((t) => t.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('listTransactions does not expose the internal array', () => {
  // It returns a copy: a caller that sorts or splices the result must not be
  // able to reorder the store's own history.
  const first = store.listTransactions();
  first.length = 0;
  assert.ok(store.listTransactions().length > 0);
});

test('every balance is an integer number of cents', () => {
  // A float here would mean euros made it into the store, bringing the
  // rounding errors that make 0.1 + 0.2 !== 0.3 a problem on real balances.
  for (const account of store.listAccounts()) {
    assert.ok(
      Number.isInteger(account.balanceCents),
      `${account.id} must be an integer, got ${account.balanceCents}`
    );
  }
});
