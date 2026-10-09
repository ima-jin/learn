# Environments — learn

Every environment variable the learn app reads — directly, through its `@ima-jin/*` dependencies, or in its
scripts — with what it does, when it is read, and its dev and prod values. This file, `.env.example`, and
`scripts/lib/env-manifest.mjs` are kept in lock-step by `scripts/__tests__/env-docs.test.ts`: CI fails if code
starts reading a variable that is not documented here.

No secret values live in this repo. Examples are shape-only placeholders (`REPLACE_ME`, `CHANGE_ME`); real values
live in the untracked `.env.local` on each host. `check-env` rejects a file that still contains a placeholder.

## The env files

| File | Used for | Lands at |
|---|---|---|
| `.env.example` | local development (`pnpm dev`) | `.env.local` in your working copy |
| `.env.dev.example` | the dev deployment (`dev-learn`, port 3103, `https://dev-jin.imajin.ai/learn`) | `~/dev/learn/.env.local` |
| `.env.prod.example` | the prod deployment (`prod-learn`, port 7103, `https://jin.imajin.ai/learn`) | `~/prod/learn/.env.local` |

On a server: `cp .env.<env>.example .env.local && chmod 600 .env.local`, fill the placeholders, then
`node scripts/check-env.mjs <prod|dev>`. `scripts/deploy.sh` runs that check for you on every deploy, and pm2 loads
the same file with `node --env-file` (see `ecosystem.config.cjs`).

## Build-time vs runtime

`next build` bakes every `NEXT_PUBLIC_*` value into the build (including `next.config.js`'s `basePath`).
**Changing one means rebuilding** — `scripts/deploy.sh` loads the env file for the build, so a normal deploy handles
it. Variables marked *runtime* are read when the process starts or per request; a `pm2 restart --update-env` is
enough.

## Dev vs prod at a glance

- **Kernel host.** Dev talks only to `https://dev-jin.imajin.ai`; prod only to `https://jin.imajin.ai`.
  `check-env.mjs` rejects a dev file pointing at a non-`dev-` host and a prod file pointing at a `dev-` host.
- **`IMAJIN_ENV`.** `dev` on dev (selects the `imajin_session_dev` cookie), **unset** on prod. A production build is
  `NODE_ENV=production` on both, so this is the only thing that tells dev from prod.
- **Database.** Separate Postgres database per environment; the schema name is `learn` in both.
- **Identity.** Each environment has its own app DID, registry id, claim code, keystore and `SESSION_SECRET`.
- **Port.** dev 3103, prod 7103 (from `ecosystem.config.cjs`, not the env file).

## Required on every deployed instance

Missing any of these and `scripts/check-env.mjs` fails the deploy before anything is built.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `DATABASE_URL` **(secret)** | runtime | `postgres://<role>:<password>@localhost:5432/<dev_db>` | `postgres://<role>:<password>@localhost:5432/<prod_db>` | Postgres connection string for this app's own database (also read by drizzle-kit and scripts/migrate-baseline.mjs). |
| `APP_DB_SCHEMA` | runtime | `learn` | `learn` | The one Postgres schema this app owns. Fixed to `learn` — the existing prod/dev schema; never change it. |
| `SESSION_SECRET` **(secret)** | runtime | (32+ random chars) | (32+ random chars) | HS256 key for the session cookie (@ima-jin/auth-client). 32+ random characters, e.g. `openssl rand -hex 32`; separate per environment. |
| `IMAJIN_AUTH_URL` | runtime | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | Kernel base URL (no path) the session helpers use for sign-in/session validation. |
| `AUTH_SERVICE_URL` | runtime | `https://dev-jin.imajin.ai/auth` | `https://jin.imajin.ai/auth` | Kernel auth service base URL, including the /auth prefix. Verifies scoped app tokens and receives learn.* attestations. |
| `IMAJIN_KERNEL_URL` | runtime | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | Kernel base URL (no path). Used to fetch this app's signing key at boot (claim / keystore) and as the PAY_SERVICE_URL fallback. |
| `REGISTRY_SERVICE_URL` | runtime | `https://dev-jin.imajin.ai/registry` | `https://jin.imajin.ai/registry` | Kernel registry service base URL, including /registry. Course creation reads the node's .fair fee config from its public node/self route. |
| `PROFILE_SERVICE_URL` | runtime | `https://dev-jin.imajin.ai/profile` | `https://jin.imajin.ai/profile` | Kernel profile service base URL, including /profile. Batched DID -> handle/name for the creator's student roster; called with NO credential. |
| `NEXT_PUBLIC_BASE_PATH` | build | `/learn` | `/learn` | Reverse-proxy path prefix the app is mounted under. Must be `/learn` (the Caddy route forwards it intact). Baked at build time; rebuild after changing. |
| `NEXT_PUBLIC_APP_URL` | build | `https://dev-jin.imajin.ai/learn` | `https://jin.imajin.ai/learn` | This app's public URL. Not the token audience — path-routed apps share one host (imajin-ai#2706); the audience is this app's registry slug (`learn`, `IMAJIN_APP_AUD` overrides), which must be in the app's registered tokenAudiences. Baked at build time. |
| `NEXT_PUBLIC_IMAJIN_AUTH_URL` | build | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | Kernel base URL exposed to the browser — builds the "Sign in with Imajin" redirect. Same value as IMAJIN_AUTH_URL. |
| `NEXT_PUBLIC_IMAJIN_APP_ID` | build | `app_<dev registry id>` | `app_<prod registry id>` | This app's public registry id (`app_…`), returned by registration. Used client-side in the sign-in redirect — safe to expose. |
| `NEXT_PUBLIC_SERVICE_PREFIX` | build | `https://dev-` | `https://` | Read by @ima-jin/config buildPublicUrl() for links to other Imajin apps (pay Connect check, events banner). `https://` on prod, `https://dev-` on dev. |
| `NEXT_PUBLIC_DOMAIN` | build | `imajin.ai` | `imajin.ai` | Companion to NEXT_PUBLIC_SERVICE_PREFIX: the platform domain. |
| `IMAJIN_APP_DID` | runtime | `did:imajin:<dev app DID>` | `did:imajin:<prod app DID>` | This app's own did:imajin:… from registration (docs/REGISTRATION.md). instrumentation.ts refuses to boot without it. Not a secret. |

## First boot only

Set once, then delete. `check-env` fails the deploy while there is neither a keystore nor a claim code.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `IMAJIN_APP_CLAIM_CODE` **(secret)** | runtime | (only on first boot) | (only on first boot) | One-time code from the kernel operator's /jin approval card. Needed only on the very first boot (no keystore yet) or a lost-keystore rebind; delete it after the first successful boot. check-env fails while there is neither a keystore nor a claim code. |

## Optional

Read by the app or its dependencies and safe to leave unset.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `PAY_SERVICE_URL` | runtime | `https://dev-jin.imajin.ai/pay` | `https://jin.imajin.ai/pay` | Kernel pay service base URL, including /pay — paid-course checkout. Defaults to $IMAJIN_KERNEL_URL/pay when unset. |
| `IMAJIN_APP_KEYSTORE` | runtime | `/home/jin/.imajin/learn.dev.keystore.json` | `/home/jin/.imajin/learn.prod.keystore.json` | Path of this app's 0600 bootstrap keystore (never the vault key itself). Default ./.imajin/keystore.json relative to the process cwd. Must be writable, persist across deploys, and be separate for dev and prod. |
| `IMAJIN_ENV` | runtime | `dev` | (unset) | Selects the kernel session cookie name in @ima-jin/config: `dev` → imajin_session_dev, anything else → imajin_session. MUST be `dev` on the dev instance (a production build is NODE_ENV=production, which does not imply dev); leave unset on prod. |
| `LOG_LEVEL` | runtime | `debug` | `info` | pino log level for @ima-jin/logger (default info). Output is stdout only; pm2 captures it. |
| `ENABLE_REQUEST_LOG` | runtime | (unset) | (unset) | Logger request-log switch. Leave unset: this app wires no log sink (AGENTS.md — stdout only). |
| `ENABLE_APP_LOG` | runtime | (unset) | (unset) | Logger persisted-log switch. Leave unset: this app never persists logs to a database. |
| `LOG_DB_TRANSPORT` | runtime | (unset) | (unset) | Logger DB-transport switch. Leave unset: logging must never touch a data store (AGENTS.md). |
| `APP_LOG_LEVEL` | runtime | (unset) | (unset) | Minimum level the logger would persist (default warn). Inert while persistence is off. |
| `MIGRATIONS_TEST_DATABASE_URL` **(secret)** | script | (unset) | (unset) | CI/test only: a throwaway Postgres server the migration tests create scratch databases on. Never used in deployment. |

## Forbidden

Setting any of these is an error.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `IMAJIN_APP_PRIVATE_KEY` **(secret)** | runtime | (never set) | (never set) | Removed. The app throws at boot if this is set — the signing key comes from loadAppSigningKey(), never from env. |

## Set by the platform — not in the env file

Provided by pm2 (`ecosystem.config.cjs`) or Next.js.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `PORT` | runtime | `3103` | `7103` | Listen port. Set by the pm2 ecosystem entry (prod 7103, dev 3103); only used directly by `pnpm dev`. |
| `NODE_ENV` | runtime | `production` | `production` | Set to `production` by the pm2 entry and by `next build`/`next start`. Do not set it in the env file. |
| `NEXT_RUNTIME` | runtime | (set by Next.js) | (set by Next.js) | Injected by Next.js; instrumentation.ts only bootstraps the signing key when it is `nodejs`. Never set by hand. |

## Read by dependencies on paths learn does not use

Leave unset. Listed so the contract covers every variable the installed packages read.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `ATTESTATION_INTERNAL_API_KEY` **(secret)** | runtime | (unset) | (unset) | @ima-jin/auth act-as / service attestation calls. learn attests with its own delegated app key instead; leave unset. Never hand-mint it. |
| `AUTH_INTERNAL_API_KEY` **(secret)** | runtime | (unset) | (unset) | Deprecated @ima-jin/auth internal key (agent delegation). Not used by learn; leave unset. |
| `PROFILE_INTERNAL_API_KEY` **(secret)** | runtime | (unset) | (unset) | @ima-jin/auth credential resolution key. learn holds no service-scope secret by design (emails are never released to it); leave unset. |
| `NODE_DID` | runtime | (unset) | (unset) | @ima-jin/auth node-act-as check (kernel node DID). Not used by learn; leave unset. |
| `APP_URL` | runtime | (unset) | (unset) | @ima-jin/auth fallback origin for redirects. learn does not rely on it; leave unset. |
| `NEXT_PUBLIC_BASE_URL` | runtime | (unset) | (unset) | @ima-jin/auth fallback origin for redirects (after APP_URL). learn does not rely on it; leave unset. |
| `REGISTRY_URL` | runtime | (unset) | (unset) | Deprecated alias of REGISTRY_SERVICE_URL read by @ima-jin/config. Leave unset; use REGISTRY_SERVICE_URL. |
| `SESSION_COOKIE_SCOPE` | runtime | (unset) | (unset) | @ima-jin/config session-cookie scope switch (default host-only). Leave unset. |
| `NEXT_PUBLIC_BUILD_HASH` | build | (unset) | (unset) | @ima-jin/ui footer build stamp. Cosmetic; leave unset. |
| `NEXT_PUBLIC_COMMIT_COUNT` | build | (unset) | (unset) | @ima-jin/ui footer build stamp. Cosmetic; leave unset. |
| `NEXT_PUBLIC_VERSION` | build | (unset) | (unset) | @ima-jin/ui footer version stamp. Cosmetic; leave unset. |
| `NEXT_PUBLIC_NOTIFY_URL` | build | (unset) | (unset) | @ima-jin/ui notification widget endpoint. learn renders no such widget; leave unset. |

## Dev example

`.env.dev.example` (copy to `~/dev/learn/.env.local`):

```dotenv
# learn — DEV deployment env (dev-learn, port 3103, https://dev-jin.imajin.ai/learn)
# Copy to ~/dev/learn/.env.local on the server (chmod 600) and fill the
# placeholders. Never commit the real file. Reference: docs/ENVIRONMENTS.md.
# Validate with: node scripts/check-env.mjs dev

# --- Build-time (baked in by `next build` — rebuild after changing) ---
NEXT_PUBLIC_BASE_PATH=/learn
NEXT_PUBLIC_APP_URL=https://dev-jin.imajin.ai/learn
NEXT_PUBLIC_IMAJIN_AUTH_URL=https://dev-jin.imajin.ai
# Registry id (app_...) returned by registration — docs/REGISTRATION.md
NEXT_PUBLIC_IMAJIN_APP_ID=app_REPLACE_ME
NEXT_PUBLIC_SERVICE_PREFIX=https://dev-
NEXT_PUBLIC_DOMAIN=imajin.ai

# --- Runtime ---
# PORT and NODE_ENV come from the pm2 entry (ecosystem.config.cjs).
# MUST be `dev` here: selects the imajin_session_dev cookie.
IMAJIN_ENV=dev

DATABASE_URL=postgres://learn:CHANGE_ME@localhost:5432/imajin_dev
APP_DB_SCHEMA=learn
# 32+ random chars, separate per environment: openssl rand -hex 32
SESSION_SECRET=REPLACE_ME

IMAJIN_AUTH_URL=https://dev-jin.imajin.ai
AUTH_SERVICE_URL=https://dev-jin.imajin.ai/auth
IMAJIN_KERNEL_URL=https://dev-jin.imajin.ai
REGISTRY_SERVICE_URL=https://dev-jin.imajin.ai/registry
PROFILE_SERVICE_URL=https://dev-jin.imajin.ai/profile
PAY_SERVICE_URL=https://dev-jin.imajin.ai/pay

# --- Identity (operator step: docs/REGISTRATION.md) ---
IMAJIN_APP_DID=did:imajin:REPLACE_ME
# First boot only (no keystore yet) — paste the one-time code from the /jin
# approval card, then delete this line after the app has booted once.
# IMAJIN_APP_CLAIM_CODE=
# Persistent, per-environment keystore (must survive deploys):
IMAJIN_APP_KEYSTORE=/home/jin/.imajin/learn.dev.keystore.json

LOG_LEVEL=debug
```

## Prod example

`.env.prod.example` (copy to `~/prod/learn/.env.local`):

```dotenv
# learn — PROD deployment env (prod-learn, port 7103, https://jin.imajin.ai/learn)
# Copy to ~/prod/learn/.env.local on the server (chmod 600) and fill the
# placeholders. Never commit the real file. Reference: docs/ENVIRONMENTS.md.
# Validate with: node scripts/check-env.mjs prod

# --- Build-time (baked in by `next build` — rebuild after changing) ---
NEXT_PUBLIC_BASE_PATH=/learn
NEXT_PUBLIC_APP_URL=https://jin.imajin.ai/learn
NEXT_PUBLIC_IMAJIN_AUTH_URL=https://jin.imajin.ai
# Registry id (app_...) returned by registration — docs/REGISTRATION.md
NEXT_PUBLIC_IMAJIN_APP_ID=app_REPLACE_ME
NEXT_PUBLIC_SERVICE_PREFIX=https://
NEXT_PUBLIC_DOMAIN=imajin.ai

# --- Runtime ---
# PORT and NODE_ENV come from the pm2 entry (ecosystem.config.cjs).
# IMAJIN_ENV is deliberately NOT set on prod (prod uses the imajin_session
# cookie). check-env.mjs rejects IMAJIN_ENV=dev here.

DATABASE_URL=postgres://learn:CHANGE_ME@localhost:5432/imajin_prod
APP_DB_SCHEMA=learn
# 32+ random chars, separate per environment: openssl rand -hex 32
SESSION_SECRET=REPLACE_ME

IMAJIN_AUTH_URL=https://jin.imajin.ai
AUTH_SERVICE_URL=https://jin.imajin.ai/auth
IMAJIN_KERNEL_URL=https://jin.imajin.ai
REGISTRY_SERVICE_URL=https://jin.imajin.ai/registry
PROFILE_SERVICE_URL=https://jin.imajin.ai/profile
PAY_SERVICE_URL=https://jin.imajin.ai/pay

# --- Identity (operator step: docs/REGISTRATION.md) ---
IMAJIN_APP_DID=did:imajin:REPLACE_ME
# First boot only (no keystore yet) — paste the one-time code from the /jin
# approval card, then delete this line after the app has booted once.
# IMAJIN_APP_CLAIM_CODE=
# Persistent, per-environment keystore (must survive deploys):
IMAJIN_APP_KEYSTORE=/home/jin/.imajin/learn.prod.keystore.json

LOG_LEVEL=info
```

## Secrets handling

- `DATABASE_URL` (carries the DB password), `SESSION_SECRET` and `IMAJIN_APP_CLAIM_CODE` are the only secret-bearing
  variables a correct deployment sets. Keep `.env.local` mode `0600`, owned by the deploy user, never in git.
- This app's signing key is **never** in an env file — `IMAJIN_APP_PRIVATE_KEY` makes the app refuse to boot. The key
  is fetched at boot by `loadAppSigningKey()`; only the 0600 bootstrap keystore (`IMAJIN_APP_KEYSTORE`) is
  persisted. Treat that file like the claim code: never commit, copy, or sync it (`.imajin/` is git-ignored).
- `check-env.mjs` and the deploy script print variable *names* only, never values.
