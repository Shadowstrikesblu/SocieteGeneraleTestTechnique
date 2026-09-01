# Load test results

Two runs of `script.js` against the public URL, four minutes each:
30s ramp to 10 VUs, 1m ramp to 60, 2m plateau at 60, 30s ramp down.

Both runs hit the same deployed commit (`14a6afd`). The only difference is the
autoscaling ceiling.

## Run 1 — ceiling at one replica

The first run was made before `terraform apply` had pushed the autoscale rule
to Azure: the live configuration was still `min=1 max=1 rules=null`. Scale-out
was impossible by construction, so this run measures the capacity of a single
replica. It is kept here because that is a useful number, not because it was
intended.

| Metric | Value |
|---|---|
| Throughput | 164 req/s (39 405 requests) |
| Latency p95 | 703 ms |
| Latency avg / median / max | 370 ms / 393 ms / 1.15 s |
| Failed requests | 0.00 % |
| Checks passed | 52 540 / 52 540 |
| Backend replicas | 1 throughout |

## Run 2 — autoscaling enabled (max 5, 10 concurrent requests per replica)

| Metric | Value | vs run 1 |
|---|---|---|
| Throughput | **625 req/s** (150 045 requests) | **×3.8** |
| Latency p95 | **188 ms** | **−73 %** |
| Latency avg / median / max | 92 ms / 85 ms / 562 ms | −75 % |
| Failed requests | 0.00 % | = |
| Checks passed | 200 060 / 200 060 | = |
| Backend replicas | **1 → 5** | — |

Both thresholds are assertions, and both passed: `http_req_failed < 1%` and
`http_req_duration p(95) < 1500ms`.

### Scale-out timeline

Replica counts sampled every 30s with `az containerapp replica list`:

| Elapsed | Backend | Frontend |
|---|---|---|
| t+37s | 2 | 5 |
| t+74s | **5** | 5 |
| t+111s → t+331s | 5 | 5 |

KEDA polls every 30s, so the first new replica appears within about one
polling interval of the threshold being crossed, and the ceiling is reached
roughly 40s later.

### Two independent proofs, and they agree

This is the point of the exercise, not the raw numbers:

1. **Platform side** — `az containerapp replica list` reported 5 backend
   replicas.
2. **Application side** — every response carries `meta.instance`, and the k6
   run observed 5 distinct replica names:

```
ca-sgtest-backend--0000004-85555b869d-p7s29
ca-sgtest-backend--0000004-85555b869d-pwqhp
ca-sgtest-backend--0000004-85555b869d-rjglf
ca-sgtest-backend--0000004-85555b869d-rl7wt
ca-sgtest-backend--0000004-85555b869d-wbxkn
```

Either measurement alone could be an artefact of how it was taken. That the
platform's own accounting and the traffic actually served agree on the same
number is the argument.

## Caveats

- The load is read-only. `POST /api/transfers` debits a finite in-memory
  balance, so sustained write load would drain the accounts and return 422s
  that the failure threshold would count as errors — measuring the fixture
  rather than the system. The write path is covered by unit tests instead.
- The 10-concurrent-requests threshold is deliberately low so scale-out is
  observable within a four-minute test. A production value would come from
  latency measured under real traffic.
- KEDA's cooldown is 300s, so two runs must be spaced five minutes apart or
  the second starts already scaled and never shows the ramp.
- Load was generated from a single machine in France; this measures the
  service, not a geographically distributed client population.
