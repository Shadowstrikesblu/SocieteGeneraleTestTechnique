# Test Technique Société Générale

A small banking client area — accounts, recent operations and transfers —
containerized and running on Azure Container Apps.

Link to the App: <https://ca-sgtest-frontend.lemonsmoke-7b6c27a7.francecentral.azurecontainerapps.io>

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


## Known limitations

Nothing checks that deployed infrastructure matches the code.
Terraform state is a local file 
There is no authentication.
`/metrics` is exposed but nothing scrapes it,
The load test is read-only and run from a single machine.
