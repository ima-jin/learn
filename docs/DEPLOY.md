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
   values), including "a first boot has a claim code". See [ENVIRONMENTS.md](./ENVIRONMENTS.md).
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

- **Mint the app identity** — separately for dev and prod ([REGISTRATION.md](./REGISTRATION.md#minting-the-app-identity-operator-runbook)):
  register the app, approve it on the kernel's `/jin` operator card to mint a one-time **claim code**, put it in
  `.env.local` as `IMAJIN_APP_CLAIM_CODE` together with the registry's `IMAJIN_APP_DID` and
  `NEXT_PUBLIC_IMAJIN_APP_ID`, and deploy. The first boot spends the code and writes the 0600 keystore
  (`IMAJIN_APP_KEYSTORE`); **delete `IMAJIN_APP_CLAIM_CODE` afterwards**. `check-env.mjs` fails while an identity
  value is still a placeholder, and while there is neither a keystore nor a claim code. No key is ever made by hand
  and none ever appears in `.env.local` or a log.
- **Create the databases/roles** and put the connection strings in each `.env.local`. Prod/dev already contain the
  `learn` schema and data; the baseline adopts it in place.
- **`SESSION_SECRET`** — `openssl rand -hex 32`, one per environment.
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
- **Health never goes green on a first boot** — `pm2 logs <name>`: a used/rejected `IMAJIN_APP_CLAIM_CODE` or a wrong
  `IMAJIN_APP_DID` fails at `instrumentation.ts`. Dev and prod each need their own DID, claim code and keystore. A
  spent or lost claim needs the operator to re-approve with `reissueClaim: true`.
- **Login loops on dev only** — `IMAJIN_ENV=dev` is missing (wrong session cookie name).
- **401s from scoped tokens** — `NEXT_PUBLIC_APP_URL`'s host is not in the app's registered `tokenAudiences`.
