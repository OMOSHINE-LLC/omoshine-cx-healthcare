# OMOSHINE CX Planner – Healthcare Edition

Commissioning management for hospitals and healthcare facilities, by OMOSHINE LLC.
This is a standalone product, separate from the Hyperscale and Building Editions.

This repository holds the **MVP**: checklists, functional performance tests, issues with
ball-in-court, ASHRAE 170 room compliance, and the essential electrical system (EES), on top
of e-signatures, a tamper-evident audit trail and tenant isolation.

> **Requirement values need code review.** Every value in the code-requirement library is
> seeded with `verified: false`. A qualified reviewer must confirm each value against licensed
> copies of the adopted code editions before a project relies on it. The app shows "Value
> pending code review" until then.

## What's in the box

| Path | What it is |
| --- | --- |
| `packages/rules` | Code-requirement library (ASHRAE 170, NFPA 99/110, USP 797/800), state profiles (CA, NY, FL, TX), overlay engine and pure compliance evaluators. |
| `apps/api` | Fastify + PostgreSQL REST API (`/api/v1`). Row-level security per tenant, role and scope based access, e-signatures with step-up re-authentication, hash-chained audit log, TAB CSV import, branded HTML reports. |
| `apps/web` | React web app in the OMOSHINE palette: readiness dashboard, room compliance grid and room data sheet, EES dashboard, checklists and tests with signing, issues log, ICRA daily log, ILSM / fire watch, medical gas verification and survey binder screens. |

### Phase 2: infection control and interim life safety

- **ICRA zones.** The class (I to IV) comes from the construction type and patient risk group matrix. A manual
  override can raise the class but never lower it. Infection Prevention signs the permit with PIN re-authentication,
  and any change to the zone requires a new sign-off.
- **Daily ICRA log.** Yes/no controls for the zone's class plus a pressure reading for Class III and IV. Logs are
  append-only. A failed inspection opens a high-priority issue automatically. Each zone shows a 30-day history.
- **ILSM assessments.** Required measures come from the deficiency type. A fire watch is added when an alarm or
  sprinkler system is out of service for more than 4 hours. An assessment cannot be resolved until every measure is
  documented, and it is locked once resolved.
- **Fire watch.** One-tap patrol entries, append-only, with alerts for gaps longer than the patrol interval.
- **Medical gas verification (NFPA 99 Chapter 5).** Zones with their gases and outlets. The required tests are
  built automatically: cross-connection and valve tests per zone; standing pressure, alarm, particulate and purity per
  gas; function, pressure and flow, and concentration per outlet. Only the medical gas verifier records results, with
  their credential; results are append-only and a failure opens a critical life safety issue. The verifier certifies
  the zone with an e-signature once every latest result passes, and a new outlet or retest requires recertification.
- **Survey binder.** One page and one printable, branded report that gathers the evidence a surveyor or AHJ asks
  for: room ventilation compliance, signed checklists and tests, essential electrical, ICRA, ILSM and fire watch,
  medical gas certification, open issues, and record integrity (signature count and, for administrators, an audit
  chain check). It lists the gaps to close before the survey, life safety first. Generating the report is audited.
- The ICRA matrix, control list, ILSM measures, fire watch thresholds and medical gas limits are seeded as
  `verified: false` until the consultant review confirms them.

## Running locally

Requirements: Node 20+, PostgreSQL 16 (or Docker).

```bash
npm install
docker compose up -d db                          # or use your own Postgres 16
export ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/omoshine
export DATABASE_URL=postgres://omoshine_app:omoshine_app@localhost:5432/omoshine
npm run migrate -w @omoshine/api
npm run seed -w @omoshine/api                     # prints demo logins (PIN 2468)
npm run dev:api                                   # http://localhost:3001
npm run dev:web                                   # http://localhost:5173
```

## Tests

```bash
npm test          # rules unit tests, API integration tests against real Postgres, web component tests
npm run typecheck
```

API tests start a throwaway PostgreSQL cluster automatically (set `PG_BIN` if the binaries are not
in `/usr/lib/postgresql/16/bin`), or use an existing server via `TEST_ADMIN_DATABASE_URL` and
`TEST_DATABASE_URL` (as CI does).

What the tests cover:

- **Compliance engine**: ACH maths, boundary values, missing readings never pass, pressure sign and
  minimum differential, life safety severity, state/AHJ overlays (replace, add, disable, effective dates),
  NFPA 110 10-second transfer, generator monthly (including exhaust-temperature alternative) and 36-month tests.
- **Security**: authentication, tenant isolation through the API and through raw SQL on the app role,
  role and scope permissions (AHJ read-and-sign only, clinical read and raise issues), append-only tables
  (privileges and triggers), audit chain verification and tamper detection.
- **Workflows**: test run lifecycle, re-authentication before signing, signature meanings per role,
  locking after signature, superseding corrections, TAB import (all-or-nothing), project overlays,
  issue numbering under concurrency, ball-in-court history, life safety close rules, readiness roll-up,
  QR resolution, report branding and HTML escaping.
- **Web**: status chips carry text labels, life safety flag, room data sheet, EES branch cards, signing dialog,
  and WCAG AA contrast of the brand and status colour pairs.

## Security model (summary)

- No PHI anywhere in the schema.
- The API connects as `omoshine_app`, a non-owner role subject to row-level security on every tenant table;
  `app.tenant_id` is set per transaction from the signed session token.
- Test measurements, EES tests, signatures, issue events and the audit log are append-only: the app role has
  no UPDATE/DELETE privilege and triggers refuse changes even for the owner.
- A signed test run is frozen; corrections create a superseding run linked to the original.
- Each signature stores the SHA-256 of the canonical record content, the signer, role, meaning and
  re-authentication method. `GET /test-runs/:id/verify` re-checks them.
- The audit log is a per-tenant hash chain; `GET /audit/verify` recomputes it.
- Dev login uses email + PIN. Production uses the hospital's IdP (OIDC/SAML) with step-up for signing.
  Change `JWT_SECRET` and the `omoshine_app` password before any shared deployment.

## Not yet in the MVP

Offline mobile app, photo markup, PDF rendering of reports (HTML reports are print-ready), SSO wiring,
webhooks and the remaining Phase 2 and 3 modules (integrations, operations
handoff). See the design package for the roadmap.

---
Generated by OMOSHINE CX Planner – OMOSHINE LLC
