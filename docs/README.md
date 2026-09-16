# Documentation index

Two layers of docs exist, on purpose:

- **This directory (`docs/`)**: task-oriented references — how to run the
  app locally, what the API looks like, what the schema is, how to deploy,
  back up, monitor, and respond to an incident.
- **[`docs/governance/`](governance/README.md)**: the quality baseline —
  current-state architecture, the risk/technical-debt register, the
  Definition of Done, and the process that governs changes. Read that
  directory for *why* things are the way they are and what's still a known
  gap; read this directory for *how* to actually do something.

Don't duplicate between the two — if content already lives in
`governance/`, this index links to it rather than restating it.

## Getting started

| Doc | What it covers |
|---|---|
| [local-development.md](local-development.md) | Five-minute local setup, running the app, running checks. |
| [configuration.md](configuration.md) | Every environment variable, grouped, with what breaks (or doesn't) if it's unset. |
| [data-model.md](data-model.md) | Database schema by domain area, key tables and relationships. |
| [roles-permissions.md](roles-permissions.md) | The seven roles and exactly what each can/can't do. |
| [api/README.md](api/README.md) | API conventions and an index of route areas. |

## How things work

| Doc | What it covers |
|---|---|
| [offline-sync.md](offline-sync.md) | The offline write queue: idempotency, retry/conflict behavior, what a rep sees. |
| [erp-integration.md](erp-integration.md) | ERP sync ownership, frequency, retries, reconciliation — points to the full contract doc. |
| [governance/architecture.md](governance/architecture.md) | System diagram, layers, integrations, deployment topology. |

## Operating it

| Doc | What it covers |
|---|---|
| [deployment.md](deployment.md) | Day-to-day deploy steps (fast vs. full checks) and the one-time droplet setup. |
| [backup-restore.md](backup-restore.md) | The current manual backup process and how to restore from it. |
| [monitoring.md](monitoring.md) | What's actually monitored today, what isn't, where to look when something's wrong. |
| [incident-response.md](incident-response.md) | Step-by-step: detect, contain (the lockdown switch), communicate, resolve, write it up. |
| [release-process.md](release-process.md) | Versioning policy, what every release needs, the path to 1.0.0. |

## Process and quality baseline

See [`governance/README.md`](governance/README.md) for the full list —
architecture, severity definitions, the risk register, critical user
journeys, Definition of Done, ownership matrix, and security posture.
