# Espace Client — Containerized App on Azure Container Apps

A small banking client area (accounts, transactions, transfers), containerized
and deployed to Azure Container Apps through a GitHub Actions pipeline.

The point of this exercise is not feature richness. It is the engineering
decisions: what runs where, what is exposed, how a new version reaches
production, and how the system behaves when it is under load or when something
fails.

> **Status.** This README grows with the repository. Sections still marked _TODO_
> are not yet implemented — see [Known limitations](#known-limitations--possible-improvements)
> for what is deliberately out of scope.

## Architecture

```
Internet → frontend (public ingress, nginx :8080, non-root)
              └── proxy /api ──→ backend (internal ingress, Node :3000)
           Container Apps Environment · stdout → Log Analytics
```

- **Frontend** — Vue 3 + Vite, built to static files, served by
  `nginx-unprivileged`. The only publicly reachable component.
- **Backend** — Node 20 + Express, in-memory store, no database. Reachable only
  from inside the Container Apps environment.
- **Registry** — GHCR, images tagged with the commit SHA.
- **Infrastructure** — Terraform: resource group, Log Analytics workspace,
  Container Apps environment, two apps.
- **CI/CD** — GitHub Actions, authenticating to Azure with federated OIDC
  (no stored credentials).

**The backend has no public route.** That is the main security property of this
design, and it costs nothing.

## Running locally

_TODO_

## How it is built and deployed

_TODO_

## Key technical decisions

_TODO — each decision recorded with its trade-off, not just the choice._

## Behaviour under load

_TODO — k6 results: p95, error rate, throughput, and observed scale-out._

## Known limitations & possible improvements

_TODO_
