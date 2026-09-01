'use strict';

const os = require('os');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const client = require('prom-client');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

// Identifies which replica answered. Returned in every response so that
// horizontal scaling can be proven from the client side, independently of
// what the platform reports.
const INSTANCE = process.env.CONTAINER_APP_REPLICA_NAME || os.hostname();

// JSON to stdout. Container Apps ships stdout to Log Analytics, where
// structured fields are queryable; a plain text line would only be greppable.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Every line carries the replica that emitted it, so a log search can be
  // narrowed to one instance without correlating by timestamp.
  base: { instance: INSTANCE }
});

// --- Metrics -----------------------------------------------------------
const registry = new client.Registry();
registry.setDefaultLabels({ instance: INSTANCE });
// Process-level metrics: heap, event loop lag, CPU, open handles.
client.collectDefaultMetrics({ register: registry });

const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry]
});

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency.',
  labelNames: ['method', 'route', 'status'],
  // Buckets tuned for a fast JSON API; the top bucket catches outliers.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry]
});

// Probes and scrapes are high-frequency and carry no diagnostic signal.
// Logging them would bury real traffic and inflate ingestion cost: at a 5s
// readiness interval that is 17k lines a day per replica.
const NOISY = new Set(['/api/health', '/metrics']);

// Flipped by the shutdown handler so /api/health starts failing readiness
// before the server stops accepting connections.
let shuttingDown = false;

// Time given to the platform to notice this replica is unready and stop
// routing to it, before any socket is closed.
const READINESS_GRACE_MS = Number(process.env.READINESS_GRACE_MS || 8000);
// Time given to in-flight requests to finish once the socket is closed.
const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS || 10000);
// 8 + 10 = 18s worst case, inside the 30s the platform grants before SIGKILL.

app.disable('x-powered-by');

// JSON bodies only, size-bounded: an unbounded POST body is a trivial
// denial-of-service vector.
app.use(express.json({ limit: '16kb' }));

app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => NOISY.has(req.url) },

    // The default serializers copy every request and response header: roughly
    // 2 KB of noise per line (user-agent, sec-ch-ua, x-envoy-*), unreadable
    // and long enough that Azure truncates mid-JSON. Keep only what actually
    // helps diagnose.
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ status: res.statusCode })
    }
  })
);

// Record every request, probes included: metrics are aggregates, so the noise
// that would ruin a log stream costs nothing here.
app.use((req, res, next) => {
  const done = httpDuration.startTimer();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      // The MATCHED route, not the raw path. Labelling with req.path would let
      // anyone probing random URLs create an unbounded number of label values
      // and blow up the metric's cardinality.
      route: req.route ? req.route.path : 'unmatched',
      status: res.statusCode
    };
    httpRequests.inc(labels);
    done(labels);
  });
  next();
});

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
  // While draining, answer 503. This fails the readiness probe, which is what
  // makes the platform stop routing new requests here. Liveness tolerates
  // three failures at 10s, so this never triggers a restart during the drain.
  if (shuttingDown) {
    return res.status(503).json({ status: 'shutting_down', instance: INSTANCE });
  }
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

// Prometheus scrape target. It sits on the backend, which has no public
// ingress, so the metrics are not reachable from the internet.
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});

app.use((req, res) => fail(res, 404, 'not_found', `No route for ${req.method} ${req.path}.`));

// Last-resort handler. Without it Express prints the stack trace into the
// response body, which leaks internals to the caller.
app.use((err, req, res, next) => {
  // Malformed JSON is a client error, not a server fault.
  if (err.type === 'entity.parse.failed' || err.status === 400) {
    return fail(res, 400, 'invalid_json', 'Request body is not valid JSON.');
  }
  logger.error({ err }, 'unhandled error');
  return fail(res, 500, 'internal_error', 'Unexpected server error.');
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'backend listening');
});

// Container Apps sends SIGTERM on every deploy, scale-in and restart. Node
// running as PID 1 has no default handler, so without this the process is
// killed outright and in-flight requests are dropped.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, readinessGraceMs: READINESS_GRACE_MS }, 'shutdown signal received, failing readiness');

  // Deregister first, close second. Closing the socket immediately would race
  // the load balancer, which is still sending traffic to a replica it does
  // not yet know is going away.
  setTimeout(() => {
    logger.info('readiness grace elapsed, draining connections');

    server.close(() => {
      logger.info('drain complete, exiting cleanly');
      process.exit(0);
    });

    // Keep-alive sockets sit idle between requests and would otherwise hold
    // server.close() open until they time out on their own.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    // Never hang forever: one client holding a connection open must not stop
    // the replica from terminating.
    setTimeout(() => {
      logger.warn('drain timeout exceeded, forcing exit');
      process.exit(1);
    }, DRAIN_TIMEOUT_MS).unref();
  }, READINESS_GRACE_MS).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
