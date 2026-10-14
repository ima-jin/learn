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
build. The env file is the single source of truth: contract variables exported in the calling shell are ignored
(and listed by name), because `node --env-file` and `pm2 --update-env` would otherwise let a stray `DATABASE_URL`
win. Step 2 swaps in the new ref's `deploy.sh`, so a change to the script itself takes effect from the *next* run.

1. **preflight** — `git`, `node` (>= `.nvmrc`), `pnpm`, `pm2`, `curl` on `PATH`; no local changes to tracked files;
   `.env.local` exists; no stale `pm2` entry of the same name pointing at a different path (see
   [cutover](#one-time-cutover-checklist)).
2. **checkout** — `git fetch --tags --prune`, then `git checkout --detach` the ref (default `origin/main`). Never
   `git pull`.
3. **env check** — `scripts/check-env.mjs <target>` validates `.env.local` for the target (names only, never
   values). A missing keystore only warns; claim at `/learn/claim` after boot. See [ENVIRONMENTS.md](./ENVIRONMENTS.md).
4. **install** — `pnpm install --frozen-lockfile`.
5. **build** — `next build` with `.env.local` loaded, so `NEXT_PUBLIC_*` values are baked in.
6. **baseline + migrate** — `scripts/migrate-baseline.mjs` (idempotent; refuses on mismatch), then
   `drizzle-kit migrate` (forward-only). See [Migration baseline](#migration-baseline).
7. **restart** — `pm2 startOrReload ecosystem.config.cjs --only <prod|dev>-learn --update-env`, then `pm2 save`.
8. **health** — polls `/learn/api/health` for up to 60 s and requires `"status":"ok"`. A non-healthy result exits
   non-zero.

## First deploy of an environment (fresh checkout)

There is no checkout of this repo on the server yet. After the operator steps below are done, it is one command per
environment:

```bash
git clone https://github.com/ima-jin/learn.git ~/prod/learn && cd ~/prod/learn
cp .env.prod.example .env.local && chmod 600 .env.local   # then fill in the placeholders
scripts/deploy.sh prod
```

Use `~/dev/learn` and `.env.dev.example` / `scripts/deploy.sh dev` for dev. Deploy **dev first** and confirm
`https://dev-jin.imajin.ai/learn/api/health` before touching prod.

### Operator steps this repo cannot do

- **Claim the app identity** — separately for dev and prod ([REGISTRATION.md](./REGISTRATION.md#minting-the-app-identity-operator-runbook)):
  register the app and configure its public `IMAJIN_APP_DID`, `NEXT_PUBLIC_IMAJIN_APP_ID` and persistent
  `IMAJIN_APP_KEYSTORE` path. Deploy through the deployment tool; without a keystore the app boots unclaimed
  and `check-env` only warns. Approve provisioning on `/jin`, then open `/learn/claim` and paste the one-time
  code in the browser. The app goes live immediately and writes the `0600` keystore — no env edit or restart.
  Already-claimed apps keep using their existing keystore. No key is ever made by hand or appears in a log.
- **Create the databases/roles** and put the connection strings in each `.env.local`. Prod/dev already contain the
  `learn` schema and data; the baseline adopts it in place.
- **`SESSION_SECRET`** — provision through the approved secret-management tool, separately per environment (not changed by this claim-path upgrade).
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
```

- **Idempotent.** The ledger is drizzle's own journal, `"learn"."__drizzle_migrations"` (the `migrations` block in
  `drizzle.config.ts`) — one row per applied migration, keyed by the SHA-256 of its SQL file. If migration 0000 is
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
  `drizzle-kit migrate` then creates everything.
- Exit codes: `0` ok · `1` refused (mismatch) · `2` usage/config/connection error.

After the baseline, `drizzle-kit migrate` applies only migrations newer than 0000. Migrations are forward-only; there
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
