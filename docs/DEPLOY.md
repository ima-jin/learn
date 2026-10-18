# Deploying learn (prod + dev)

learn is deployed from **this repo**, as its own pm2 process behind the kernel host's Caddy — the same shape as
every other registered app. Nothing in the kernel repo builds, migrates or restarts it from this repo's code, and
nothing here imports kernel internals: learn talks to the kernel only through scoped app tokens, the published
`@ima-jin/*` SDK and the kernel's public API.

| | dev | prod |
|---|---|---|
| pm2 process | `dev-learn` | `prod-learn` |
| Checkout on the server | `~/dev/learn` | `~/prod/learn` |
| Local port | `3103` | `7103` |
| Public URL | `https://dev-jin.imajin.ai/learn` | `https://jin.imajin.ai/learn` |
| Health | `http://127.0.0.1:3103/learn/api/health` | `http://127.0.0.1:7103/learn/api/health` |
| Env file | `.env.dev.example` → `.env.local` | `.env.prod.example` → `.env.local` |

The ports, the pm2 names and the Caddy route are the ones the monorepo's `apps/learn` already used, so cutover
needs no proxy change.

## Vault self-secret rollout order

**App-code adoption only (#25): do not deploy this change or edit dev/prod env as part of this PR.**
Production cutover timing remains a separate operator decision; keep imajin-ai#2260 separate.
The baseline and migration entry points below fetch the database credential directly from the vault.
Never put it in the settings file, a shell command/session, or an SSH transfer.

Apply this order separately on **each environment** (dev, then prod):

1. First deploy a kernel that includes **ima-jin/imajin-ai#2801** (kernel-issued, sealed app self-secrets)
   and operator-supplied secrets from #2821. The app uses npmjs.org auth-client >= 0.8.24 (#2851).
2. **Sync the manifest secrets on `/jin`** for this app from `imajin.app.json`.
3. Use **App secrets set/rotate with owner countersign** to seal `DATABASE_URL` through the tool.
   Keep `SESSION_SECRET` generated (`random-32B`), not operator-supplied.
4. **Only then upgrade this app**, within the separately approved cutover.

Otherwise a claimed app fails closed at boot: required vault credentials are unavailable, so startup exits
with status 1 rather than serving with an env fallback. An unclaimed boot still skips the vault and exposes
the browser claim path. Legacy env entries for vault-issued credentials are ignored; the warning names
each entry and asks you to delete it, never printing its value.

## Kernel-signed callback rollout order

**Deploy a kernel that signs callbacks (ima-jin/imajin-ai#2800) before upgrading this receiver**, separately for
each environment. Dev Learn is already live, but the dev kernel is still on pre-#2800 code at this rollout:
upgrade and verify the dev kernel first, then deploy this Learn version. Repeat kernel-first for prod.
Unsigned legacy callbacks are rejected with 401 and cannot create paid enrollments; do not deploy this receiver
against a kernel that still sends them, and do not restore a shared callback credential as a workaround.

The kernel signs; Learn verifies with the published SDK using `IMAJIN_APP_DID` and `AUTH_SERVICE_URL`.
Preserve the writable public-key pins in `.imajin/kernel-webhook-pins/` across deploys/rollbacks.
Discovery, trust and storage failures return 503 without business processing so the kernel can retry;
signature, audience, freshness and replay failures remain 401. See
[Kernel webhook verification](./ARCHITECTURE.md#kernel-webhook-verification-ima-jinlearn15) for the single-process
nonce-store constraints.

## The one command

From the target's checkout on the server:

```bash
scripts/deploy.sh dev     # or: scripts/deploy.sh prod
scripts/deploy.sh prod --ref v0.2.0   # a specific tag / sha (this is also the rollback)
scripts/deploy.sh prod --dry-run      # print the plan, execute nothing
```

It is fail-fast: any failure before step 7 stops the deploy and the running process keeps serving the previous
build. The env file holds non-secret settings only: contract variables exported in the calling shell are ignored
(and listed by name). `DATABASE_URL` is forbidden in that file and is never a migration fallback.
Step 2 swaps in the new ref's `deploy.sh`, so a change to the script itself takes effect from the *next* run.

1. **preflight** — `git`, `node` (>= `.nvmrc`), `pnpm`, `pm2`, `curl` on `PATH`; no local changes to tracked files;
   `.env.local` exists; no stale `pm2` entry of the same name pointing at a different path (see
   [cutover](#one-time-cutover-checklist)).
2. **checkout** — `git fetch --tags --prune`, then `git checkout --detach` the ref (default `origin/main`). Never
   `git pull`.
3. **env check** — `scripts/check-env.mjs <target>` validates `.env.local` for the target (names only, never
   values). A missing keystore warns, but migration step 6 requires it: use the unclaimed browser-claim
   shell to establish it before running deployment migrations. See [ENVIRONMENTS.md](./ENVIRONMENTS.md).
4. **install** — `pnpm install --frozen-lockfile`.
5. **build** — `next build` with `.env.local` loaded, so `NEXT_PUBLIC_*` values are baked in.
6. **baseline + migrate** — `scripts/migrate-baseline.mjs` (idempotent; refuses on mismatch), then
   `scripts/migrate.mjs` (programmatic Drizzle postgres-js migrator, forward-only). Both load the
   same non-secret env file as step 3 and fetch `DATABASE_URL` in memory using `loadFromVault()`,
   with `IMAJIN_APP_DID`, `IMAJIN_KERNEL_URL`, `IMAJIN_APP_KEYSTORE` and `onMissing: 'fail'`.
   They need the app's existing claimed bootstrap keystore; a missing/refused credential stops deployment
   before restart with a value-free recovery message. See [Migration baseline](#migration-baseline).
7. **restart** — `pm2 startOrReload ecosystem.config.cjs --only <prod|dev>-learn --update-env`, then `pm2 save`.
8. **health** — polls `/learn/api/health` for up to 60 s and requires `"status":"ok"`. A non-healthy result exits
   non-zero.

## First deploy of an environment (fresh checkout)

There is no checkout of this repo on the server yet. Prepare the checkout/settings, then complete the operator
claim prerequisite below before running the deployment command:

```bash
git clone https://github.com/ima-jin/learn.git ~/prod/learn && cd ~/prod/learn
cp .env.prod.example .env.local && chmod 600 .env.local   # then fill in the placeholders
# Establish the bootstrap keystore through the browser claim shell first.
scripts/deploy.sh prod
```

Use `~/dev/learn` and `.env.dev.example` / `scripts/deploy.sh dev` for dev. Deploy **dev first** and confirm
`https://dev-jin.imajin.ai/learn/api/health` before touching prod.

### Operator steps this repo cannot do

- **Self-secrets** — sync the names/kinds from `imajin.app.json` on `/jin`, then use
  App secrets set/rotate with owner countersign for the operator-supplied database credential.
  Boot awaits `createVaultBoot()` and keystore-authenticated encrypted fetch before importing
  application server/DB initialization. No database credential or session signing key belongs
  in env. For rotation or recovery, use the tools and restart with no secret file edit.

- **Claim the app identity** — separately for dev and prod ([REGISTRATION.md](./REGISTRATION.md#minting-the-app-identity-operator-runbook)):
  register the app and configure its public `IMAJIN_APP_DID`, `NEXT_PUBLIC_IMAJIN_APP_ID` and persistent
  `IMAJIN_APP_KEYSTORE` path. A missing keystore permits only the unclaimed application shell, not migrations.
  First start that shell through the approved process tool, approve provisioning on `/jin`, then open
  `/learn/claim` and paste the one-time code in the browser. Claim writes the `0600` keystore — no secret env edit.
  The deployment's baseline/migrate step can then authenticate with it before restarting the app.
  Already-claimed apps keep using their existing keystore. No key is ever made by hand or appears in a log.
- **Create the databases/roles** through the approved operator path and seal connection strings using
  `/jin` App secrets set/rotate with owner countersign, never `.env.local`. Prod/dev already contain
  the `learn` schema and data; the vault-backed baseline and migrator adopt/apply this repo's history.
- **Caddy** — the route already exists; verify it against the [snippet below](#caddy).

### One-time cutover checklist

1. Back up the `learn` schema (`pg_dump --schema=learn …`) before the first prod run.
2. `pm2 delete prod-learn && pm2 save` (and `dev-learn`) while the old entries still point at the monorepo's
   `~/prod/imajin-ai/apps/learn` path. `deploy.sh` refuses to run while a same-named entry points elsewhere,
   because pm2 would "reload" it with the old script and cwd. Removing old entries is deliberately never automatic.
   Stop the kernel repo's deploy from restarting `prod-learn`/`dev-learn` at the same time (kernel-side change, out
   of scope for this repo), or it will take the port back.
3. Optionally dry-run the baseline against prod first: `node --env-file=.env.local scripts/migrate-baseline.mjs --dry-run`.
4. `scripts/deploy.sh dev`, verify, then `scripts/deploy.sh prod`.

## Migration baseline

The existing `learn` schema was created by the kernel monorepo's shared root migrations (`0001_seed.sql` +
`0018_learn_course_type.sql`), long before this repo had its own drizzle history. This repo's
`migrations/0000_learn_schema.sql` uses bare `CREATE TABLE`s, so a plain `pnpm db:migrate` against prod/dev would
fail on the first table. `scripts/migrate-baseline.mjs` bridges that, using this repo's own migrations:

```bash
node --env-file=.env.local scripts/migrate-baseline.mjs            # baseline (what deploy.sh runs)
node --env-file=.env.local scripts/migrate-baseline.mjs --dry-run  # validate only, write nothing
node --env-file=.env.local scripts/migrate.mjs                   # apply pending migrations
```

- **Vault-backed.** Both entry points use `scripts/lib/migration-credentials.mjs` and the published SDK's
  keystore-authenticated encrypted fetch of the required `DATABASE_URL`. Values remain in memory, never env
  or disk. No `process.env.DATABASE_URL` lookup or fallback exists. Provider/connection/cleanup errors are
  sanitized; use `/jin` App secrets sync/set/rotate with owner countersign before retrying.
  `MIGRATIONS_TEST_DATABASE_URL` is an explicit disposable CI/test override only; leave it unset on servers.
- **Idempotent.** The ledger is drizzle's own journal, `"learn"."__drizzle_migrations"` (configured explicitly in
  `scripts/migrate.mjs`) — one row per applied migration, keyed by the SHA-256 of its SQL file. If migration 0000 is
  already recorded the runner does nothing and exits 0, so `deploy.sh` runs it every time.
- **Refuses on mismatch.** It introspects the live `learn` schema (tables, columns, types, nullability, defaults,
  primary/unique keys, foreign keys and their actions, required indexes) and compares it with what migration 0000
  produces. Any difference — missing/extra table or column, wrong type or default, missing FK or index, or
  unrecognised rows already in the journal — exits **1** with a list of the problems and changes nothing. Tolerated:
  constraint *names*, column order (prod gained `course_type` by ALTER) and extra indexes. Reconcile the schema by
  hand; never force it.
- **Never drops, truncates, or alters.** App tables are only ever read through `pg_catalog` SELECTs — no app row is
  read or written. The only writes are `CREATE SCHEMA/TABLE IF NOT EXISTS` for the journal and one `INSERT` of the
  0000 hash, in one transaction under an advisory lock. The tests audit every statement issued.
- **Fresh databases** (no `learn` schema) are left alone: it reports "nothing to baseline" and exits 0, and
  `scripts/migrate.mjs` then creates everything.
- Exit codes: `0` ok · `1` refused (mismatch) · `2` usage/config/connection error.

After the baseline, `scripts/migrate.mjs` applies only migrations newer than 0000. `drizzle.config.ts` is used
only by `pnpm db:generate` and contains no connection credential. Migrations are forward-only; there
is no down-migration. New migrations must be additive/guarded (`IF NOT EXISTS`) — see [MIGRATIONS.md](./MIGRATIONS.md).

## pm2

`ecosystem.config.cjs` defines `prod-learn` (7103) and `dev-learn` (3103). Each entry execs
`node_modules/next/dist/bin/next start -p <port>` directly (never `npm start`: pm2 would track the npm wrapper and
orphan `next-server` on restart), loads `.env.local` with `node --env-file` (Node exits if the file is missing, so a
learn with no env crashes loudly instead of booting without its identity), uses this checkout as `cwd`, and logs to
`~/.pm2/logs/<name>-out.log` / `<name>-error.log`. A checkout only ever starts its own entry (`--only`).

```bash
pm2 logs prod-learn --lines 100     # stdout (the app logs to stdout only)
pm2 describe prod-learn
```

## Caddy

The route is unchanged from the monorepo era. The app is mounted under the `/learn` basePath and Caddy must forward
the prefix **intact** — use `handle`, not `handle_path` (which strips it):

```caddy
# prod — inside the existing jin.imajin.ai site block
jin.imajin.ai {
    @learn path /learn /learn/*
    handle @learn {
        reverse_proxy localhost:7103
    }
    # ...the rest of the site (kernel and other apps) unchanged
}

# dev — inside the existing dev-jin.imajin.ai site block
dev-jin.imajin.ai {
    @learn path /learn /learn/*
    handle @learn {
        reverse_proxy localhost:3103
    }
}
```

Verify: `curl -fsS https://jin.imajin.ai/learn/api/health` → `{"status":"ok","service":"learn",…}`.

## Rollback

Redeploy the previous tag or sha: `scripts/deploy.sh prod --ref <previous-tag>`. Migrations are forward-only, so a
rollback is only safe while migrations stay additive.

## Troubleshooting

- **`baseline` exits 1** — the message lists exactly what differs. Do not edit the script to force it; fix the schema
  (or tell the app owner the schema drifted), then re-run.
- **`env check` fails** — each line names a variable; see [ENVIRONMENTS.md](./ENVIRONMENTS.md).
- **Unclaimed after boot** — open `/learn/claim` and redeem the code from `/jin`. Health reports
  `claimed: false` until the claim succeeds; it still reports `status: ok`. A lost keystore needs operator
  re-approval with `reissueClaim: true`, followed by the same browser claim. Existing-keystore authentication
  failures still stop boot; check the registered DID and kernel availability.
- **Login loops on dev only** — `IMAJIN_ENV=dev` is missing (wrong session cookie name).
- **401s from scoped tokens** — `NEXT_PUBLIC_APP_URL`'s host is not in the app's registered `tokenAudiences`.
