# Learn — a third-party app on Imajin

> Forked from [`ima-jin/imajin-app-template`](https://github.com/ima-jin/imajin-app-template). **Read
> [`AGENTS.md`](./AGENTS.md) first** — it defines the boundary this app must not cross.

**Database:** Postgres schema `learn` (`APP_DB_SCHEMA=learn`) — `courses`, `modules`, `lessons`, `enrollments`,
`lesson_progress`, defined in `src/db/schema.ts` and created by `pnpm db:migrate`.

**Platform:** [Imajin](https://imajin.ai) (sovereign-tech kernel) · **Reference app:** `ima-jin/imajin-scorecard`

This repository **is the app** — a real, arms-length third-party application that composes the Imajin platform
**only through its public app surface** (`requireAppAuth` + the documented kernel API). It holds **no `workspace:*`
deps, no monorepo internals, no DB access, no in-process bus** — it talks to Imajin as an external client. Published
`@ima-jin/*` SDK packages (from npmjs.org, no auth needed) are fine to depend on; they're the same versioned
artifact every app — first-party or third-party — consumes.

## Source of truth is the user's

This app holds nothing authoritative. The signed records are **the user's own**, on their per-DID path. The kernel is
the authoritative **index/projection** of those records — not their owner. The user can walk with their records and
everything still verifies. (See `AGENTS.md` §3.)

## How it composes Imajin

| Header | Meaning |
|--------|---------|
| `X-App-DID` | this app's DID (from registration) |
| `X-App-Authorization` | the attestation ID from the user's consent flow |

The kernel verifies both and returns `{ appDid, userDid, scopes }` — that triple is the app's entire authority.

## What this app does

Courses → modules → lessons, enrollment (free, or paid through the kernel's pay service) and per-lesson progress. The
HTTP API is documented in [`api-spec/openapi.yaml`](./api-spec/openapi.yaml) (served at `/api/spec`); a contract test
keeps it in lockstep with the route files. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the auth model and
the (short, deliberate) list of differences from the original in-monorepo `apps/learn`.

```bash
pnpm install
pnpm test        # route tests run real SQL against the real migrations in-process (PGlite) — no Postgres needed
pnpm lint && pnpm typecheck && pnpm build
```

## Getting started

1. **Use this template** (GitHub's "Use this template" button, or `git clone` + a new remote).
2. **Register this app with the kernel** — see [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
   You'll get back this app's `appDid` and registry `id`.
3. **Set env**: `cp .env.example .env.local`, then fill in `IMAJIN_APP_DID`,
   `NEXT_PUBLIC_IMAJIN_APP_ID`, `SESSION_SECRET`, `APP_DB_SCHEMA`, `DATABASE_URL`, `IMAJIN_KERNEL_URL`,
   and (first boot only) `IMAJIN_APP_CLAIM_CODE`. This app refuses to start without `IMAJIN_APP_DID`
   set, or if a raw `IMAJIN_APP_PRIVATE_KEY` is present (see `instrumentation.ts`) — it fetches its
   own signing key at boot via `@ima-jin/auth-client`'s `loadAppSigningKey()` instead; see
   [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
4. **Migrate this app's own database** (its own Postgres schema only — see
   [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md)):
   ```bash
   pnpm install
   pnpm db:migrate
   ```
5. **Run it**:
   ```bash
   pnpm dev
   ```
   `/api/health` and `/api/spec` should respond immediately; `/api/me` returns your DID once
   you sign in through the header's "Sign in with Imajin" link.

## Identity — minting the app DID (operator)

Dev and prod are registered separately; each gets its own app DID, registry id, claim code and keystore. No key is
ever hand-made or placed in `.env.local`:

1. Register the app against that environment's kernel ([`docs/REGISTRATION.md`](./docs/REGISTRATION.md)) and note the
   `appDid` and registry `id`.
2. On the kernel's **`/jin`** operator dashboard, approve the app's `apps.provision` card — this mints a one-time
   **claim code** (shown once).
3. Put it in the target's `.env.local` as `IMAJIN_APP_CLAIM_CODE` (with `IMAJIN_APP_DID`,
   `NEXT_PUBLIC_IMAJIN_APP_ID` and a persistent `IMAJIN_APP_KEYSTORE`) and deploy. The first boot redeems it via
   `loadAppSigningKey()` and persists only a `0600` bootstrap keystore; then **delete the claim code**.

learn does not have an in-app `/claim` page yet (the browser "paste the code here" flow `links` has), so the code
travels through the env var for now — details in the
[operator runbook](./docs/REGISTRATION.md#minting-the-app-identity-operator-runbook).

## Deploying (prod + dev)

One command per environment, from that environment's checkout on the server (`~/prod/learn`, `~/dev/learn`):

```bash
scripts/deploy.sh dev                  # or prod; add --dry-run to print the plan, --ref <tag> to pin / roll back
```

It checks the env file, installs, builds, **baselines and migrates** the database, restarts pm2 (`prod-learn` on
port 7103, `dev-learn` on 3103) and polls `/learn/api/health`. The Caddy route (`/learn`, prefix kept intact), the pm2
entry, the idempotent migration baseline for the existing prod/dev schema (refuses on mismatch, never drops
anything) and the one-time cutover checklist are in [`docs/DEPLOY.md`](./docs/DEPLOY.md); every environment variable
is in [`docs/ENVIRONMENTS.md`](./docs/ENVIRONMENTS.md) (`.env.example`, `.env.dev.example`, `.env.prod.example`).

## Consuming `@ima-jin/*`

Published `@ima-jin/*` packages (e.g. `@ima-jin/auth-client`, `@ima-jin/config`, `@ima-jin/ui`) are served from
npmjs.org, the default registry — no `.npmrc` scoping and no auth token needed to install them:

```bash
pnpm add @ima-jin/auth-client
```

## Layout

```
AGENTS.md          ← boundary + scope for coding agents (read first)
README.md          ← this file
docs/
  ARCHITECTURE.md  ← design notes
  REGISTRATION.md  ← how to register this app with the kernel
  MIGRATIONS.md    ← this app's schema-ownership rule
  DEPLOY.md        ← deploy runbook: pm2, Caddy, migration baseline, cutover
  ENVIRONMENTS.md  ← every environment variable, dev vs prod
app/               ← Next.js App Router: pages + API routes
src/
  components/      ← client components
  lib/             ← auth config, signing-identity (loadAppSigningKey boot path), base-path, other helpers
  db/              ← this app's own drizzle schema (never a kernel schema)
migrations/        ← generated by `pnpm db:generate`, applied by `pnpm db:migrate`
api-spec/          ← this app's own OpenAPI document, served at /api/spec
scripts/           ← deploy.sh, check-env.mjs, migrate-baseline.mjs (+ tests)
ecosystem.config.cjs ← pm2 entries: prod-learn (7103), dev-learn (3103)
instrumentation.ts ← boot-env guards + loadAppSigningKey() bootstrap (see docs/REGISTRATION.md)
```

## This app's own signing key

This app never reads a raw private key from env. `instrumentation.ts` fails loud at boot if
`IMAJIN_APP_PRIVATE_KEY` is set, and instead calls `@ima-jin/auth-client`'s `loadAppSigningKey()`:
a one-time claim code (`IMAJIN_APP_CLAIM_CODE`) bootstraps a local `0600` keystore
(`IMAJIN_APP_KEYSTORE`) on first boot; every later boot re-authenticates with that keystore, no
operator action needed. See [`docs/REGISTRATION.md`](./docs/REGISTRATION.md#4-fetch-this-apps-own-signing-key-at-boot-7).

## Mounting under a path prefix

Set `NEXT_PUBLIC_BASE_PATH` (e.g. `/coffee`) when this fork is served behind a reverse-proxy path
prefix instead of at `/`. `next.config.js` reads it for Next's own `basePath` (covers `<Link>` and
`router.push` automatically); route any raw `fetch()`, `<a href>`, or `redirect()` through
`src/lib/base-path.ts`'s `withBasePath()` helper, since Next.js doesn't rewrite those.

## The honest test

Every Imajin app before the external integrators was first-party (same repo, same server, privileged access). Apps
built from this template are the **external-integrator** test: if this app can do everything it needs through app-auth
and the public API alone, the federated-app boundary is real.
