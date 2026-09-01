# Espace Client

A small banking client area — accounts, recent operations and transfers —
containerized and running on Azure Container Apps.

Live: <https://ca-sgtest-frontend.lemonsmoke-7b6c27a7.francecentral.azurecontainerapps.io>

```
backend/    Node 20 + Express, in-memory data, no database
frontend/   Vue 3 + Vite, built to static files and served by nginx
infra/      Terraform for the Azure side
load/       k6 script and the results it produced
.github/    test, build and deploy pipeline
```

## Architecture

```
Internet → frontend (public ingress, nginx :8080, non-root)
              └── proxy /api ──→ backend (internal ingress, Node :3000)
           Container Apps Environment · stdout → Log Analytics
```

The frontend is the only thing exposed to the internet. It serves the static
bundle and proxies `/api` to the backend, which sits on internal ingress and has
no public route at all — that is the main security property of this setup, and
it costs nothing.

The API is small: accounts, transactions, beneficiaries, a health endpoint, and
`POST /api/transfers`, which is the only way to write anything. Responses are
wrapped in `{ data, meta: { instance } }`, where `instance` is the replica that
answered — useful later, when checking that scaling actually happened.

Amounts are integer cents throughout. Euros only appear in the browser, at
display time, because `0.1 + 0.2 !== 0.3` is not something you want anywhere
near a balance.

## Running it locally

```bash
docker compose up --build   # → http://localhost:8080
```

The backend has no published port, deliberately: locally as in the cloud, it is
reachable only from the frontend, so `curl localhost:3000` failing is the
expected result. If port 8080 is unavailable — on Windows, Hyper-V reserves
ranges that often include it — override the host port:

```bash
FRONTEND_PORT=9080 docker compose up --build
```

Without Docker, `npm ci && npm run dev` in each of `backend/` and `frontend/`;
Vite proxies `/api` to port 3000, so the code path is the same as in production.
Tests are `npm test` in `backend/`.

## How it gets deployed

Every push to `main` runs the same three stages: unit tests, then both images
built and pushed to GHCR tagged with the commit SHA, then a deploy that updates
the two Container Apps and smoke-tests the public URL. The smoke test matters —
`az containerapp update` returning success only means the request was accepted,
not that the application works, so the pipeline polls `/api/health` through the
public URL and fails if it never answers.

Images are deployed by SHA, never by `:latest`. Container Apps compares the
image string, so redeploying the same `latest` tag creates no revision and the
deployment silently does nothing.

GitHub authenticates to Azure with federated OIDC, so no credential is stored
anywhere, and the service principal holds `Contributor` on the single resource
group rather than on the subscription.

Terraform owns the infrastructure and the pipeline owns the running version.
They coexist because the image field sits under `ignore_changes`; without that,
the next `terraform apply` would roll production back to whatever tag is written
in `variables.tf`.

## Decisions worth explaining

**Container Apps rather than AKS.** Ingress, autoscaling, probes and log
shipping come with the platform. The same thing on AKS is a day of plumbing, and
the trade is that there is no room for custom controllers or a service mesh.

**Liveness is patient, readiness is quick.** Restarting a replica is expensive
and drops in-flight requests, so liveness waits (10s, three failures). Taking a
replica out of rotation is cheap and reversible, so readiness reacts in 5s. A
liveness probe that is too eager turns a slow minute into a restart loop and
causes the outage it was supposed to catch.

**The health check tests nothing downstream.** If it reported the health of a
dependency, one backend incident would fail the probe on every replica at once
and restart them all, turning a partial failure into a total one.

**Shutdown fails readiness before closing the socket.** On SIGTERM the process
answers 503 for eight seconds while still serving real requests, then drains.
Closing first would race the load balancer, which is still sending traffic to a
replica it does not yet know is leaving.

**Transfers validate everything before touching a balance,** so a rejected
transfer leaves no partial write. That is what the unit tests actually assert,
and moving the debit above the balance check makes exactly that test fail.

## Behaviour under load

Two four-minute k6 runs against the public URL, 60 virtual users at plateau, on
the same deployed commit. Details in [`load/RESULTS.md`](load/RESULTS.md).

| | One replica | Autoscaling (max 5) |
|---|---|---|
| Throughput | 164 req/s | 625 req/s |
| Latency p95 | 703 ms | 188 ms |
| Failed requests | 0.00 % | 0.00 % |

The backend went from 1 to 5 replicas in about 40 seconds. Two independent
measurements agree on that number: `az containerapp replica list` on the
platform side, and five distinct `meta.instance` values observed by k6 on the
application side. Either one alone could be an artefact of how it was taken;
both agreeing is the actual evidence.

The thresholds in the script are assertions rather than observations — a load
test that cannot fail proves nothing.

## Known limitations

**State lives in memory and is not shared between replicas.** This is the real
one. Under autoscaling, a transfer made on one replica is invisible to the other
four, and balances reset whenever a replica restarts. The demo survives because
the load test is read-only; anything real needs a database.

**Nothing checks that deployed infrastructure matches the code.** This actually
bit during the build: the probes and the autoscale rule were committed but
`terraform apply` had not been run, so the live config was still capped at one
replica. The first load test showed a flat line, which is how it was found. A
`terraform plan -detailed-exitcode` step in the pipeline would have caught it
immediately.

**Terraform state is a local file** — not shared, not locked, not backed up. A
remote backend with state locking is the standard fix.

**There is no authentication.** Anyone with the URL can read the accounts and
issue transfers. Fine for fixture data, obviously not for anything else.

**`/metrics` is exposed but nothing scrapes it**, and nothing alerts on the logs
being collected. There is one environment and no staging, and a rollback means
redeploying a previous SHA by hand.

**The load test is read-only and run from a single machine.** Sustained writes
would drain the in-memory balances and return 422s, which would measure the
fixture rather than the system.
