# Espace Client — Containerized App on Azure Container Apps

A small banking client area (accounts, transactions, transfers), containerized
and deployed to Azure Container Apps through a GitHub Actions pipeline.

**Live:** <https://ca-sgtest-frontend.lemonsmoke-7b6c27a7.francecentral.azurecontainerapps.io>

The point of this exercise is not feature richness. It is the engineering
decisions: what runs where, what is exposed, how a new version reaches
production, and how the system behaves under load and when something fails.

---

## Architecture

```
Internet → frontend (public ingress, nginx :8080, non-root)
              └── proxy /api ──→ backend (internal ingress, Node :3000)
           Container Apps Environment · stdout → Log Analytics
```

| Component | Choice |
|---|---|
| Frontend | Vue 3 + Vite, built to static files, served by `nginx-unprivileged` |
| Backend | Node 20 + Express 4, in-memory store, no database |
| Registry | GHCR, images tagged with the commit SHA |
| Infrastructure | Terraform — resource group, Log Analytics, environment, 2 apps |
| CI/CD | GitHub Actions, federated OIDC to Azure, no stored credential |
| Region | `francecentral` |

**The backend has no public route.** `external_enabled = false` on its ingress
means it is reachable only from inside the Container Apps environment — in
practice, only from the frontend. That is the main security property of this
design, and it costs nothing.

### API

Every response uses the same envelope, `{ data, meta: { instance } }`, where
`meta.instance` is the replica that answered. Errors use
`{ error: { code, message }, meta }`.

| Method | Route | Role |
|---|---|---|
| GET | `/api/health` | Probe target. No dependency checks. Answers 503 while draining. |
| GET | `/api/accounts` | Accounts and balances |
| GET | `/api/transactions` | Operations, newest first, optional `?accountId=` |
| GET | `/api/beneficiaries` | Transfer destinations |
| POST | `/api/transfers` | Debit an account — the only write path |
| GET | `/metrics` | Prometheus format. On the backend, so not publicly reachable. |

`POST /api/transfers` returns 404 for an unknown account or beneficiary, 400
for an invalid amount, 422 for an insufficient balance, and 201 with the
created operation on success.

**Amounts are integer cents everywhere.** Floats cannot represent decimal
fractions exactly — `0.1 + 0.2 !== 0.3` — which is disqualifying on balances.
Conversion to euros happens in the browser, at display time only.

---

## Running locally

### With Docker (same topology as production)

```bash
docker compose up --build
# → http://localhost:8080
```

The backend has **no published port**, locally or in the cloud: it is reachable
only from the frontend. `curl localhost:3000` failing is the expected result,
not a problem.

> **On Windows**, Hyper-V reserves port ranges and 8080 is often inside one, so
> the bind fails with nothing listening on it. Check with
> `netsh interface ipv4 show excludedportrange protocol=tcp` and override the
> host port:
>
> ```bash
> FRONTEND_PORT=9080 docker compose up --build
> ```

### Without Docker

```bash
cd backend  && npm ci && npm run dev    # :3000
cd frontend && npm ci && npm run dev    # :5173, proxies /api to :3000
```

Vite's dev proxy and nginx expose the API at the same `/api` path, so no code
branches on the environment.

### Tests

```bash
cd backend && npm test
```

---

## How it is built and deployed

### Pipeline

`.github/workflows/ci-cd.yml`, on every push to `main`:

```
test  ──→  build-and-push (matrix: frontend, backend)  ──→  deploy
 │              │                                            │
 │              └── GHCR, tagged :<commit-sha> and :latest    │
 │                                                           ├── az containerapp update
 └── node --test on the write path                           └── smoke test, or fail the run
```

- **Tests run first.** A logic regression must not produce an image, let alone
  reach the registry.
- **Pull requests build but never publish.** A fork must not be able to push an
  image into this registry.
- **The deploy job deploys the commit SHA, never `:latest`.** Container Apps
  compares the image *string*: redeploying the same `:latest` tag creates no
  revision, so the deployment silently does nothing.
- **The smoke test gates the green run.** `az containerapp update` succeeding
  means "request accepted", not "application works" — it polls the public URL
  until `/api/health` answers, and fails the pipeline if it never does.

### Infrastructure

`infra/` provisions five resources: resource group, Log Analytics workspace,
Container Apps environment, and the two apps. Applied from a workstation with
`terraform apply`; state is local (see
[Limitations](#known-limitations--possible-improvements)).

### The split between them

**Terraform owns the infrastructure. The pipeline owns the running version.**

Both apps carry:

```hcl
lifecycle {
  ignore_changes = [template[0].container[0].image]
}
```

Without it, the next `terraform apply` would roll the running image back to the
tag written in `variables.tf`, undoing every deployment since. With it, the two
tools can run in any order without fighting. This is observable: the Terraform
state holds `...backend:latest`, Azure runs `...backend:14a6afd…`, and
`terraform plan` proposes no change to the image.

### Authentication

GitHub Actions authenticates to Azure with **federated OIDC**: no secret is
stored anywhere. GitHub proves its identity, Azure issues a token valid for
minutes. The service principal holds `Contributor` **on the single resource
group**, not on the subscription.

---

## Key technical decisions

Each with what it costs, not only what it buys.

**Container Apps rather than AKS.** Ingress, autoscaling, probes, revisions and
log shipping come with the platform; the same setup on AKS is a day of
plumbing. *Cost:* no custom controllers, no service mesh, and a ceiling on how
far the deployment model can be bent.

**Backend on internal ingress.** The public attack surface is one nginx serving
static files. *Cost:* the backend cannot be reached directly for debugging —
every diagnostic goes through the frontend or through platform logs.

**Immutable SHA tags.** Every revision traces to an exact commit, and a
rollback is redeploying a previous SHA. *Cost:* image count grows; a retention
policy would be needed over time.

**OIDC instead of a stored secret.** Nothing long-lived exists to leak or
rotate. *Cost:* the trust is a federated credential whose subject must match
exactly — a repository rename breaks deployment until it is updated.

**Asymmetric probes.** Restarting is expensive and drops in-flight requests, so
liveness is patient (10s, 3 failures). Removing a replica from rotation is
cheap and reversible, so readiness is fast (5s). An aggressive liveness probe
turns a slow minute into a restart loop and *causes* the outage it was meant to
catch.

**The health check tests no dependency.** If `/api/health` reported the health
of something downstream, one backend incident would fail the probe on every
replica at once and restart them all — a partial failure amplified into a total
one.

**Readiness fails before the socket closes.** On SIGTERM the process answers
503 for 8s *before* calling `server.close()`. Closing first would race the load
balancer, which is still routing traffic to a replica it does not yet know is
going away. *Cost:* every deployment takes ~8s longer per replica.

**Integer cents.** `0.1 + 0.2 !== 0.3` is disqualifying on balances. *Cost:*
every display path must divide by 100, and that conversion is a place bugs can
hide — so it lives in exactly one function.

**Validation before mutation.** `createTransfer` runs every check before
touching a balance, so a rejected transfer leaves no partial write. This is the
property the unit tests assert, and it is verified by mutation: moving the debit
above the balance check makes exactly that test fail.

**Machine-readable error codes, French wording in the UI.** The API returns
`insufficient_funds`; the interface owns the sentence. Translating server-side
would make the display language part of the API contract, which a second locale
or a mobile client would immediately have to work around.

**Metrics labelled by matched route, not raw path.** Labelling with `req.path`
would let anyone probing random URLs create an unbounded number of label values
and blow up the metric's cardinality. Unmatched requests collapse into
`route="unmatched"`.

**Probes and scrapes excluded from application logs, but counted in metrics.**
At a 5s readiness interval that is ~17k lines a day per replica, which would
bury real traffic and inflate ingestion cost. A metric is an aggregate, so the
same noise costs nothing there.

---

## Behaviour under load

Full method and caveats in [`load/RESULTS.md`](load/RESULTS.md). Two four-minute
k6 runs against the public URL, same deployed commit, 60 virtual users at
plateau. Both thresholds are **assertions**, not observations — a load test that
cannot fail proves nothing.

| | 1 replica | Autoscaling (max 5) |
|---|---|---|
| Throughput | 164 req/s | **625 req/s** (×3.8) |
| Latency p95 | 703 ms | **188 ms** (−73 %) |
| Latency avg | 370 ms | 92 ms |
| Requests | 39 405 | 150 045 |
| Failed | **0.00 %** | **0.00 %** |
| Checks | 52 540 / 52 540 | 200 060 / 200 060 |

Scale-out, sampled every 30s:

| Elapsed | Backend replicas |
|---|---|
| t+37s | 2 |
| t+74s | **5** (ceiling) |
| t+331s | 5 |

KEDA polls every 30s, so the first new replica appears within about one polling
interval of the threshold being crossed.

**Two independent proofs, and they agree.** `az containerapp replica list`
reported 5 backend replicas; the k6 run independently observed 5 distinct
`meta.instance` values in the response bodies. Either measurement alone could be
an artefact of how it was taken — that the platform's accounting and the traffic
actually served agree on the same number is the argument.

**The scale threshold of 10 concurrent requests per replica is deliberately
low** so scale-out is observable within a four-minute test. A production value
would come from latency measured under real traffic.

### Graceful shutdown

```
shutdown signal received, failing readiness    ← t+0,  /api/health → 503
readiness grace elapsed, draining connections  ← t+8s
drain complete, exiting cleanly                ← t+8s, exit code 0
```

Verified in a container: during the drain `/api/health` answers 503 while
`/api/accounts` still answers 200 — the replica leaves rotation without refusing
a single request.

```bash
docker stop -t 30 <container>   # exit code 0, not 137
```

> The `-t` matters: on Docker 29.4.3 a bare `docker stop` killed the container
> after ~2s with exit 137. Azure Container Apps grants 30s, which the 8s + 10s
> budget fits inside.

---

## Known limitations & possible improvements

Listed as found, most consequential first.

**State is in memory and not shared between replicas.** This is the real
limitation. Under autoscaling, a transfer executed on one replica is invisible
to the other four, and every balance resets when a replica restarts. The demo
survives because the load test is read-only and manual testing tends to hit one
replica; a real system needs a database, and `min_replicas = 1` would still not
save it. Fixing this is the first thing to do next.

**Nothing in CI verifies that deployed infrastructure matches the code.** This
bit during the exercise: the probes and autoscale rule were committed and
reviewed, but `terraform apply` had not been run, so the live configuration was
still `max=1 rules=null`. The first load test showed a flat line at one replica,
and that is how it was found. A `terraform plan -detailed-exitcode` step,
failing the pipeline when state drifts from code, would have caught it in 30
seconds.

**Terraform state is a local file.** It is not shared, not locked and not backed
up: two people applying at once would corrupt it, and losing the machine loses
the ability to manage the stack. A remote backend in an Azure Storage account
with state locking is the standard fix and takes minutes.

**No authentication or authorization.** Anyone with the URL can list accounts
and issue transfers. Acceptable for a demo with fixture data, unacceptable for
anything else — real work would start with an identity provider and per-account
authorization on every route, not only the write path.

**`/metrics` is exposed but nothing scrapes it.** The endpoint exists and is
correct; there is no Prometheus, no dashboard and no retention. Container Apps
can scrape it into Azure Monitor with a managed Prometheus workspace.

**No alerting.** Logs and metrics are collected; nothing watches them. Nobody
would learn about an outage except by loading the page.

**A single environment, no staging.** `main` deploys straight to the only
environment. There is no place to validate a change under realistic conditions
before users see it.

**No automated rollback.** Redeploying a previous SHA is a one-line command and
works, but it is manual: a failed smoke test fails the pipeline and leaves the
broken revision serving traffic. Container Apps supports weighted traffic
between revisions, which would allow a canary and an automatic revert.

**The readiness grace does not cover the worst case.** With
`failure_count_threshold = 3` at a 5s interval, the platform can take 15s to
mark a replica unready, while the shutdown grace is 8s. Covering it fully would
make each deployment 25s slower per replica and leave only 5s of margin under
the platform's 30s ceiling. Deployment speed was preferred; it is a trade-off,
not an oversight.

**The load test is read-only and single-origin.** `POST /api/transfers` debits a
finite in-memory balance, so sustained write load would drain the accounts and
return 422s — measuring the fixture rather than the system. Load was also
generated from one machine in France, so this measures the service, not a
geographically distributed client population.

**Resource sizing is a guess.** 0.25 vCPU and 0.5 GiB per container were not
derived from measurement. The load test suggests there is headroom, but no
profiling was done.
