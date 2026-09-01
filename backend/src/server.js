'use strict';

const os = require('os');
const express = require('express');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

// Identifies which replica answered. Returned in every response so that
// horizontal scaling can be proven from the client side, independently of
// what the platform reports.
const INSTANCE = process.env.CONTAINER_APP_REPLICA_NAME || os.hostname();

app.disable('x-powered-by');

// JSON bodies only, size-bounded: an unbounded POST body is a trivial
// denial-of-service vector.
app.use(express.json({ limit: '16kb' }));

// Every response carries the same envelope, so the client has one shape to
// parse and the replica name is never forgotten.
const ok = (res, data, status = 200) => res.status(status).json({ data, meta: { instance: INSTANCE } });
const fail = (res, status, code, message) =>
  res.status(status).json({ error: { code, message }, meta: { instance: INSTANCE } });

// Liveness/readiness probe. Deliberately checks NO dependency: if this
// reported the health of something downstream, one backend incident would
// restart every replica that depends on it, turning a partial failure into a
// total one.
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', instance: INSTANCE, uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/api/accounts', (req, res) => ok(res, store.listAccounts()));

app.get('/api/beneficiaries', (req, res) => ok(res, store.listBeneficiaries()));

app.get('/api/transactions', (req, res) => {
  const { accountId } = req.query;
  if (accountId && !store.findAccount(accountId)) {
    return fail(res, 404, 'unknown_account', `No account with id "${accountId}".`);
  }
  return ok(res, store.listTransactions(accountId));
});

// The only write path in the API, and therefore the only place worth testing
// and the only place that needs real input validation.
const TRANSFER_ERRORS = {
  unknown_account: [404, 'Source account does not exist.'],
  unknown_beneficiary: [404, 'Beneficiary does not exist.'],
  invalid_amount: [400, 'Amount must be a positive integer number of cents.'],
  insufficient_funds: [422, 'Balance is too low for this transfer.']
};

app.post('/api/transfers', (req, res) => {
  const { fromAccountId, beneficiaryId, amountCents } = req.body || {};

  const result = store.createTransfer({ fromAccountId, beneficiaryId, amountCents });

  if (result.error) {
    const [status, message] = TRANSFER_ERRORS[result.error];
    return fail(res, status, result.error, message);
  }

  return ok(res, result, 201);
});

app.use((req, res) => fail(res, 404, 'not_found', `No route for ${req.method} ${req.path}.`));

// Last-resort handler. Without it Express prints the stack trace into the
// response body, which leaks internals to the caller.
app.use((err, req, res, next) => {
  // Malformed JSON is a client error, not a server fault.
  if (err.type === 'entity.parse.failed' || err.status === 400) {
    return fail(res, 400, 'invalid_json', 'Request body is not valid JSON.');
  }
  console.error(err);
  return fail(res, 500, 'internal_error', 'Unexpected server error.');
});

app.listen(PORT, () => {
  console.log(`backend listening on :${PORT} (instance ${INSTANCE})`);
});
