'use strict';

// In-memory dataset. No database: the exercise is about the deployment path,
// and a database would add a stateful dependency without changing what is
// being demonstrated. The cost is stated openly in the README — this state is
// per-replica and is lost on restart.
//
// Amounts are stored in CENTS, as integers. Floats cannot represent decimal
// fractions exactly (0.1 + 0.2 !== 0.3), which is disqualifying for balances.
// Conversion to euros happens at display time only.

const accounts = [
  { id: 'courant', label: 'Compte Courant', number: 'FR76 •••• •••• 4021', balanceCents: 284732 },
  { id: 'livreta', label: 'Livret A', number: 'FR76 •••• •••• 8815', balanceCents: 1250000 },
  { id: 'titres', label: 'Compte Titres', number: 'FR76 •••• •••• 3390', balanceCents: 821467 }
];

const beneficiaries = [
  { id: 'b1', name: 'Marie Lefevre', iban: 'FR76 •••• •••• 1180' },
  { id: 'b2', name: 'SCI Bellevue', iban: 'FR76 •••• •••• 7734' },
  { id: 'b3', name: 'Compte Titres (interne)', iban: 'FR76 •••• •••• 3390' }
];

const transactions = [
  { id: 't1', accountId: 'courant', label: 'Virement reçu — Salaire', date: '2026-08-28', amountCents: 245000 },
  { id: 't2', accountId: 'courant', label: 'Prélèvement — Assurance habitation', date: '2026-08-27', amountCents: -3890 },
  { id: 't3', accountId: 'courant', label: 'Carte — SNCF Connect', date: '2026-08-26', amountCents: -7420 },
  { id: 't4', accountId: 'courant', label: 'Carte — Monoprix', date: '2026-08-25', amountCents: -5214 },
  { id: 't5', accountId: 'livreta', label: 'Virement reçu — Épargne', date: '2026-08-24', amountCents: 30000 }
];

let nextTransactionId = 6;

const listAccounts = () => accounts;
const findAccount = (id) => accounts.find((a) => a.id === id);
const listBeneficiaries = () => beneficiaries;
const findBeneficiary = (id) => beneficiaries.find((b) => b.id === id);

function listTransactions(accountId) {
  const rows = accountId ? transactions.filter((t) => t.accountId === accountId) : transactions;
  // Most recent first.
  return [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

/**
 * Debits an account in favour of a beneficiary.
 *
 * Returns { error } instead of throwing: the caller owns the HTTP mapping, and
 * a rejected transfer is an expected outcome, not an exceptional one.
 *
 * Every check runs BEFORE any mutation, so a rejected transfer leaves no
 * partial write behind.
 */
function createTransfer({ fromAccountId, beneficiaryId, amountCents }) {
  const account = findAccount(fromAccountId);
  if (!account) return { error: 'unknown_account' };

  const beneficiary = findBeneficiary(beneficiaryId);
  if (!beneficiary) return { error: 'unknown_beneficiary' };

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { error: 'invalid_amount' };
  }

  if (amountCents > account.balanceCents) {
    return { error: 'insufficient_funds' };
  }

  account.balanceCents -= amountCents;

  const transaction = {
    id: `t${nextTransactionId++}`,
    accountId: account.id,
    label: `Virement émis — ${beneficiary.name}`,
    date: new Date().toISOString().slice(0, 10),
    amountCents: -amountCents
  };
  transactions.push(transaction);

  return { transaction, account };
}

module.exports = {
  listAccounts,
  findAccount,
  listBeneficiaries,
  findBeneficiary,
  listTransactions,
  createTransfer
};
