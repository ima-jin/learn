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
- `DATABASE_URL` in this app's own `.env.local` points at this app's own Postgres database (or
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

drizzle's own journal is kept in `learn.__drizzle_migrations` (`migrations` block in `drizzle.config.ts`), so the
runner never creates or writes a schema other than `learn`. CI's `migrations` job runs `pnpm db:migrate` twice
against an empty Postgres and asserts exactly that.

### Adopting an existing database

`0000` uses plain `CREATE TABLE`, so it is for an **empty** database. A database that already has the kernel-created
`learn` tables (prod/dev today) must not replay it: baseline it by inserting the `0000` hash into
`learn.__drizzle_migrations` (or drop-and-restore into a fresh DB). That cutover belongs to the deploy step of #1987.

## Workflow

```bash
pnpm db:generate   # diff src/db/schema.ts against migrations/ and write new SQL
pnpm db:migrate     # apply pending migrations in migrations/ to DATABASE_URL
pnpm db:studio      # browse this app's own schema
```

`migrations/` is committed. `drizzle.config.ts` scopes `drizzle-kit` to `APP_DB_SCHEMA` only
(`schemaFilter`), so `pnpm db:generate` can never emit a migration for a table outside this
app's own schema.

## What this app does not do

- It does not squash, rewrite, or otherwise manage the kernel's own migration history — that is
  the kernel repo's concern (imajin-ai#1991's baseline-squash work), not this app's.
- It does not read another app's schema directly, even for apps that happen to share a Postgres
  instance in some deployments. If you need data another app owns, that app's owner exposes it
  through a kernel-consumed API — ask for that API, don't reach for its tables.
