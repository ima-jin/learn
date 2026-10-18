# Migrations — ownership rule

This app manages its own database with `drizzle-orm` + `drizzle-kit`, entirely separate from
the Imajin kernel's own database.

## The rule (ima-jin/imajin-ai#1991)

> An app owns tables only in its own Postgres schema. Cross-schema access from an app is a
> contract violation — it goes through the kernel API instead.

Concretely, for this app:

- This app owns exactly **one** Postgres schema, named by the `APP_DB_SCHEMA` env var
  (see `.env.example`). `src/db/schema.ts` defines every table inside that schema via
  `pgSchema(process.env.APP_DB_SCHEMA)` — there is no path to creating a table outside it.
- This app **never** connects to, queries, or migrates a kernel-owned schema (`registry`,
  `auth`, `profile`, …) or another app's schema. Every interaction with kernel-owned data goes
  through the kernel's public HTTP API (`IMAJIN_AUTH_URL`), authenticated the same way any
  other caller would be — see `docs/REGISTRATION.md` and `AGENTS.md` §2.
- Vault-supplied `DATABASE_URL` points at this app's own Postgres database (or
  a database this app has been granted a role scoped to `APP_DB_SCHEMA` in) — never the
  kernel's database.
- `APP_DB_SCHEMA` is set once, at registration time, and never changed afterwards. Renaming it
  would orphan every existing migration's tracking state.

## Learn's tables

`APP_DB_SCHEMA=learn`. `migrations/0000_learn_schema.sql` creates the schema (`IF NOT EXISTS`) and these
tables, ported column-for-column from the kernel's `migrations/0001_seed.sql` + `0018_learn_course_type.sql`:

- `courses` — top-level containers (`slug` unique; indexes on `creator_did`, `slug`)
- `modules` — sections of a course (FK → `courses`, cascade)
- `lessons` — units within a module (FK → `modules`, cascade)
- `enrollments` — student ↔ course (FK → `courses`, cascade; unique `(course_id, student_did)`)
- `lesson_progress` — per-lesson status (PK `(enrollment_id, lesson_id)`; FKs → `enrollments`, `lessons`, cascade)

drizzle's own journal is kept in `learn.__drizzle_migrations` (configured in `scripts/migrate.mjs`), so the
runner never creates or writes a schema other than `learn`. CI's `migrations` job runs `scripts/migrate.mjs` twice
against an empty Postgres and asserts exactly that.

### Adopting an existing database

`0000` uses plain `CREATE TABLE`, so it is for an **empty** database. A database that already has the kernel-created
`learn` tables (prod/dev today) must not replay it: run the baseline, which validates the live schema against `0000`
and records `0000` in `learn.__drizzle_migrations` — never replaying, dropping or altering anything:

```bash
node --env-file=.env.local scripts/migrate-baseline.mjs --dry-run   # validate only
node --env-file=.env.local scripts/migrate-baseline.mjs             # idempotent; refuses on mismatch
pnpm db:migrate                                                     # then only what is newer than 0000
```

`scripts/deploy.sh` runs both steps on every deploy. Details, the refusal rules and exit codes are in
[DEPLOY.md](./DEPLOY.md#migration-baseline).

## Workflow
Both `scripts/migrate-baseline.mjs` and `scripts/migrate.mjs` load `DATABASE_URL` in memory
through the published SDK's `loadFromVault()` with `IMAJIN_APP_DID`, `IMAJIN_KERNEL_URL`,
`IMAJIN_APP_KEYSTORE`, and `{ key: 'DATABASE_URL', onMissing: 'fail' }`. The bootstrap
keystore authenticates encrypted fetch; neither entry point reads `process.env.DATABASE_URL`.
Missing/invalid credentials and provider/connection/cleanup failures exit 2 with a value-free
recovery message, never a provider error or secret. Baseline schema mismatches retain exit 1.
The same credential-free `.env.local` that passes deploy preflight works for both migration
steps. A claimed bootstrap keystore is required; a first-run operator must establish it via
the browser claim shell before deployment migrations. Production cutover timing remains an
operator decision; this PR performs no live migrations or deployment.

Only `MIGRATIONS_TEST_DATABASE_URL` opts out of vault fetch, for disposable CI/test databases.
Leave it unset on servers. An empty/invalid explicit override fails closed, never falling back
to another env credential. No signing-key exchange or claim code is needed for migration fetch.

```bash
pnpm db:generate   # diff src/db/schema.ts against migrations/ and write new SQL
pnpm db:migrate    # load non-secret .env.local, fetch from vault, apply pending migrations
```

`migrations/` is committed. `drizzle.config.ts` is generation-only, has no `dbCredentials`, and scopes `drizzle-kit` to `APP_DB_SCHEMA` only
(`schemaFilter`), so `pnpm db:generate` can never emit a migration for a table outside this
app's own schema.

## What this app does not do

- It does not squash, rewrite, or otherwise manage the kernel's own migration history — that is
  the kernel repo's concern (imajin-ai#1991's baseline-squash work), not this app's.
- It does not read another app's schema directly, even for apps that happen to share a Postgres
  instance in some deployments. If you need data another app owns, that app's owner exposes it
  through a kernel-consumed API — ask for that API, don't reach for its tables.
