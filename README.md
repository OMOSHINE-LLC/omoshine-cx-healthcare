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
| `apps/web` | React web app in the OMOSHINE palette: readiness dashboard, room compliance grid and room data sheet, EES dashboard, checklists and tests with signing, issues log, ICRA daily log, ILSM / fire watch, medical gas verification, life safety, occupancy and activation, and survey binder screens. |

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
- **Life safety (NFPA 80, 105, 101, 72).** Inventory of fire, smoke and combination dampers, fire and smoke barrier
  doors, and fire alarm devices, added one at a time or as a batch (existing tags are skipped). Each type has a fill-in
  inspection checklist (Yes, No or N/A on every item). Due dates follow the hospital's life safety policy: dampers within
  1 year of installation then every 6 years, doors and most devices annually, waterflow and tamper switches every 6
  months, with a 30-day "due soon" window. Inspections are append-only; a failure opens a high-priority life safety
  issue and keeps the item failed until a passing inspection. The Statement of Conditions plan-for-improvement list
  numbers each deficiency, flags items past their planned completion, and locks an item once it is resolved with a
  description of the correction. A branded life safety report covers both.
- **Phased occupancy and activation.** Each phase gets an activation checklist when it is created: common items (AHJ
  final and certificate of occupancy, fire marshal acceptance, accreditor notice, ICRA close-out, water flushing,
  final air balance, staff training and orientation, equipment, nurse call and IT) plus the state agency items for CA
  (HCAI, CDPH), NY (NYSDOH), FL (AHCA) and TX (HHSC). Items are done with evidence or not applicable with a reason;
  projects can add their own. Evidence gates read the records for the phase's rooms: ventilation, functional tests,
  medical gas certification, life safety inspections and open life safety issues. The CxA or owner signs the phase
  ready (e-signature with re-authentication) only when every gate passes; the owner then records occupancy, which
  locks the phase and its checklist. A phase signed ready whose evidence later fails shows as lapsed. A branded
  activation report covers gates, checklist and sign-offs.
- **Single sign-on (OpenID Connect).** A tenant administrator connects the hospital's identity provider (Entra ID,
  Okta, Ping or any OIDC provider) for its email domains. Sign-in uses the authorization code flow with PKCE; the ID
  token is checked against the provider's keys, issuer, audience, nonce and a verified email. The first sign-in links
  the provider's subject to the account, and a different subject for that email is refused afterwards. New people are
  created (with no project roles) only when the connection allows it. E-signatures can use an SSO step-up (fresh
  sign-in forced with `prompt=login`, `max_age=0`, and `auth_time` checked) instead of the signing PIN, and a connection
  can require it. The client secret is encrypted at rest. Set `WEB_BASE_URL` to the web app's public URL.
- **Installable app with offline field entries.** The web app installs to a phone or tablet home screen. Pages already
  opened on the device still show their last data offline (cached per person and cleared on sign-out). Fire watch
  patrols, daily ICRA logs and life safety inspections made offline are kept on the device with the time they were
  made and sent when the connection returns; an entry the server refuses is kept for review. Signing always needs a
  connection.
- **Operations turnover.** Each system's required hand-over documents by discipline (O&M manual, warranty, as-builts,
  training record, plus TAB report, acceptance test report, sequence of operations, spare parts or certificates as
  applicable). Contractors submit a reference to where each document is filed; someone other than the submitter
  accepts it or rejects it with a note, and reviewed documents are closed (a correction is a new submission).
  Warranties track their end date and flag those ending within 90 days. A branded turnover package report lists all of it.
- **Final commissioning report.** A draft preview at any time, and an issued version that the CxA signs with
  re-authentication. It covers the evidence areas from the survey binder, phased occupancy, turnover, warranties and
  every outstanding item (life safety first). Each issued version is stored as frozen HTML with its SHA-256, is
  append-only, and is re-checked against its hash whenever it is opened.
- **Operations after occupancy.** A recurring compliance calendar generated from the project's generators, transfer
  switches, isolation and protective rooms, gas zones and building (generator monthly and 4-hour tests, transfer switch
  tests, battery egress lighting, water management flushing and temperatures, room pressure checks, medical gas alarms).
  Owners can tighten an interval, retire a task or add their own. Each completion answers every check; a "No" needs
  notes and opens an issue, flagged life safety for EES, life safety, ventilation and gas. The 30-day view also shows
  life safety inspections. Owner training tracks which audiences each system needs (facilities, clinical, infection
  prevention, safety, IT, clinical engineering), sessions, attendance by name only, and where the sign-in sheet is
  filed, with a branded training record. CMMS exports give an asset register with warranty end dates and a
  preventive maintenance schedule as CSV. Intervals are starting values pending review (verified=false).
- **Specialty systems.** Nurse call, pneumatic tube, real-time location (RTLS) and imaging, each with its own
  pre-functional checklist and functional test in the template library, the right discipline for turnover documents
  and training audiences, and the interfaces to prove (essential power, fire alarm, phones, RTLS presence, protection
  door locks, MRI quench and oxygen monitoring, X-ray warning lights). A passed interface test records where its record
  is filed; a failure needs notes and opens an issue, flagged life safety where the interface is. Results feed the
  survey binder and the final report. Lists are starting points pending review (verified=false).
- **Survey binder.** One page and one printable, branded report that gathers the evidence a surveyor or AHJ asks
  for: room ventilation compliance, signed checklists and tests, essential electrical, ICRA, ILSM and fire watch,
  medical gas certification, life safety inspections and the Statement of Conditions, open issues, and record integrity (signature count and, for administrators, an audit
  chain check). It lists the gaps to close before the survey, life safety first. Generating the report is audited.
- **Integrations: API keys and webhooks.** A tenant administrator creates API keys for other systems. Each key acts
  as a service user with one role on one project, is stored only as a SHA-256 hash, can be revoked, and can never
  e-sign. Webhooks send signed JSON events (`x-omoshine-signature: t=…,v1=HMAC-SHA256`) for issues, tests, room
  measurements, EES, ICRA, ILSM, medical gas, life safety inspections, plan-for-improvement items and binders. Events are written to an outbox in the same transaction as
  the change and delivered by a dispatcher with exponential back-off; targets must be public https endpoints
  (`WEBHOOK_ALLOW_INSECURE=1` relaxes this for local development only).
- **BAS trend import.** CSV of `timestamp, room_number, point, value`. Every reading is checked against the room's
  requirements through the same engine as spot readings (overlays included), giving time in compliance, each
  excursion and gaps in the trend per room; the median is recorded as a BAS measurement.
- **COBie export.** Contact, Facility, Floor, Space, Zone (departments and medical gas zones), Type, Component (assets
  and med gas outlets) and System sheets as CSV for CMMS loading. Cells starting with `= + - @` are escaped.
- **Procore and Autodesk Construction Cloud.** One-way push of commissioning issues to Procore Observations or ACC
  Issues, creating on first sync and updating only what changed. Access tokens are AES-256-GCM encrypted
  (`OMOSHINE_SECRETS_KEY`) and never returned. Base URLs are limited to the providers' API hosts. The payloads follow
  the providers' public REST documentation and **must be confirmed against a sandbox account** before go-live;
  OAuth token refresh is not automated yet (paste a fresh token with `PATCH /connections/:id`).
- The ICRA matrix, control list, ILSM measures, fire watch thresholds, medical gas limits and life safety
  inspection intervals and checklists, and the activation
  checklist, are seeded as
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
- Dev login uses email + PIN (`AUTH_MODE=dev`). Production sets `AUTH_MODE=oidc` and signs in through the hospital's
  OIDC provider, with SSO step-up or the signing PIN for e-signatures as each connection allows.
  Change `JWT_SECRET` and the `omoshine_app` password before any shared deployment.

## Not yet in the MVP

Native app store builds (the installable web app covers phones and tablets), SAML (OIDC only for now), photo markup, PDF rendering of reports (HTML reports are print-ready), Procore / ACC OAuth token refresh, and the Phase 3 operations modules. See the design
package for the roadmap.

---
Generated by OMOSHINE CX Planner – OMOSHINE LLC
