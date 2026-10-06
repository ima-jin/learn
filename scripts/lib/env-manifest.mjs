/**
 * Single source of truth for every environment variable this app (or a
 * dependency it loads, or one of its scripts) reads — refs
 * ima-jin/imajin-ai#2504. Consumed by:
 *   - scripts/check-env.mjs            (deploy preflight; never prints values)
 *   - scripts/__tests__/env-docs.test.ts (fails CI if .env.example or
 *     docs/ENVIRONMENTS.md omit a variable, or if code starts reading one
 *     that is not listed here)
 *
 * Examples here are shape-only placeholders — never real secrets.
 */
import { parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';

export const TARGETS = {
  prod: { name: 'prod-learn', port: 7103 },
  dev: { name: 'dev-learn', port: 3103 },
};

export const BASE_PATH = '/learn';

/**
 * status:
 *   required         must be set in the env file for a deployed instance
 *   first-boot       required only on the very first boot, then removed
 *   optional         read, has a safe default when unset
 *   forbidden        must NOT be set (the app refuses to boot if it is)
 *   runtime-set      injected by Next.js / pm2 — not set in the env file
 *   dependency       read by an @ima-jin/* dependency on a code path learn
 *                    does not exercise; leave unset
 * phase: 'build' = baked into the build (set before `next build`),
 *        'runtime' = read at process start / request time,
 *        'script' = read only by an operator/CI script.
 */
/**
 * @typedef {{ name: string, status: string, phase: string, summary: string,
 *             dev: string, prod: string, secret?: boolean }} EnvVar
 */

// Entry builders keep the table below readable: name, status, phase, summary,
// then the dev/prod example values (and { secret: true } where one applies).
/** @returns {EnvVar} */
const entry = (name, status, phase, summary, dev, prod, flags = {}) => ({ name, status, phase, summary, dev, prod, ...flags });
/** @returns {EnvVar} */
const same = (name, status, phase, summary, value, flags) => entry(name, status, phase, summary, value, value, flags);
/** @returns {EnvVar} */
const unset = (name, status, phase, summary, flags) => same(name, status, phase, summary, '(unset)', flags);

export const ENV_VARS = [
  entry('DATABASE_URL', 'required', 'runtime',
    'Postgres connection string for this app\'s own database (also read by drizzle-kit and scripts/migrate-baseline.mjs).',
    'postgres://<role>:<password>@localhost:5432/<dev_db>', 'postgres://<role>:<password>@localhost:5432/<prod_db>', { secret: true }),
  same('APP_DB_SCHEMA', 'required', 'runtime',
    'The one Postgres schema this app owns. Fixed to `learn` — the existing prod/dev schema; never change it.', 'learn'),
  same('SESSION_SECRET', 'required', 'runtime',
    'HS256 key for the session cookie (@ima-jin/auth-client). 32+ random characters, e.g. `openssl rand -hex 32`; separate per environment.', '(32+ random chars)', { secret: true }),
  entry('IMAJIN_AUTH_URL', 'required', 'runtime',
    'Kernel base URL (no path) the session helpers use for sign-in/session validation.',
    'https://dev-jin.imajin.ai', 'https://jin.imajin.ai'),
  entry('AUTH_SERVICE_URL', 'required', 'runtime',
    'Kernel auth service base URL, including the /auth prefix. Verifies scoped app tokens and receives learn.* attestations.',
    'https://dev-jin.imajin.ai/auth', 'https://jin.imajin.ai/auth'),
  entry('IMAJIN_KERNEL_URL', 'required', 'runtime',
    'Kernel base URL (no path). Used to fetch this app\'s signing key at boot (claim / keystore) and as the PAY_SERVICE_URL fallback.',
    'https://dev-jin.imajin.ai', 'https://jin.imajin.ai'),
  entry('REGISTRY_SERVICE_URL', 'required', 'runtime',
    'Kernel registry service base URL, including /registry. Course creation reads the node\'s .fair fee config from its public node/self route.',
    'https://dev-jin.imajin.ai/registry', 'https://jin.imajin.ai/registry'),
  entry('PROFILE_SERVICE_URL', 'required', 'runtime',
    'Kernel profile service base URL, including /profile. Batched DID -> handle/name for the creator\'s student roster; called with NO credential.',
    'https://dev-jin.imajin.ai/profile', 'https://jin.imajin.ai/profile'),
  entry('PAY_SERVICE_URL', 'optional', 'runtime',
    'Kernel pay service base URL, including /pay — paid-course checkout. Defaults to $IMAJIN_KERNEL_URL/pay when unset.',
    'https://dev-jin.imajin.ai/pay', 'https://jin.imajin.ai/pay'),
  same('NEXT_PUBLIC_BASE_PATH', 'required', 'build',
    'Reverse-proxy path prefix the app is mounted under. Must be `/learn` (the Caddy route forwards it intact). Baked at build time; rebuild after changing.', '/learn'),
  entry('NEXT_PUBLIC_APP_URL', 'required', 'build',
    'This app\'s public URL. Its HOST is the `aud` used to verify scoped app tokens — it must match a host in this app\'s registered tokenAudiences (operator-confirmed at registration). Baked at build time.',
    'https://dev-jin.imajin.ai/learn', 'https://jin.imajin.ai/learn'),
  entry('NEXT_PUBLIC_IMAJIN_AUTH_URL', 'required', 'build',
    'Kernel base URL exposed to the browser — builds the "Sign in with Imajin" redirect. Same value as IMAJIN_AUTH_URL.',
    'https://dev-jin.imajin.ai', 'https://jin.imajin.ai'),
  entry('NEXT_PUBLIC_IMAJIN_APP_ID', 'required', 'build',
    'This app\'s public registry id (`app_…`), returned by registration. Used client-side in the sign-in redirect — safe to expose.',
    'app_<dev registry id>', 'app_<prod registry id>'),
  entry('NEXT_PUBLIC_SERVICE_PREFIX', 'required', 'build',
    'Read by @ima-jin/config buildPublicUrl() for links to other Imajin apps (pay Connect check, events banner). `https://` on prod, `https://dev-` on dev.',
    'https://dev-', 'https://'),
  same('NEXT_PUBLIC_DOMAIN', 'required', 'build',
    'Companion to NEXT_PUBLIC_SERVICE_PREFIX: the platform domain.', 'imajin.ai'),
  entry('IMAJIN_APP_DID', 'required', 'runtime',
    'This app\'s own did:imajin:… from registration (docs/REGISTRATION.md). instrumentation.ts refuses to boot without it. Not a secret.',
    'did:imajin:<dev app DID>', 'did:imajin:<prod app DID>'),
  same('IMAJIN_APP_CLAIM_CODE', 'first-boot', 'runtime',
    'One-time code from the kernel operator\'s /jin approval card. Needed only on the very first boot (no keystore yet) or a lost-keystore rebind; delete it after the first successful boot. check-env fails while there is neither a keystore nor a claim code.', '(only on first boot)', { secret: true }),
  entry('IMAJIN_APP_KEYSTORE', 'optional', 'runtime',
    'Path of this app\'s 0600 bootstrap keystore (never the vault key itself). Default ./.imajin/keystore.json relative to the process cwd. Must be writable, persist across deploys, and be separate for dev and prod.',
    '/home/jin/.imajin/learn.dev.keystore.json', '/home/jin/.imajin/learn.prod.keystore.json'),
  same('IMAJIN_APP_PRIVATE_KEY', 'forbidden', 'runtime',
    'Removed. The app throws at boot if this is set — the signing key comes from loadAppSigningKey(), never from env.', '(never set)', { secret: true }),
  entry('IMAJIN_ENV', 'optional', 'runtime',
    'Selects the kernel session cookie name in @ima-jin/config: `dev` → imajin_session_dev, anything else → imajin_session. MUST be `dev` on the dev instance (a production build is NODE_ENV=production, which does not imply dev); leave unset on prod.',
    'dev', '(unset)'),
  entry('PORT', 'runtime-set', 'runtime',
    'Listen port. Set by the pm2 ecosystem entry (prod 7103, dev 3103); only used directly by `pnpm dev`.',
    '3103', '7103'),
  same('NODE_ENV', 'runtime-set', 'runtime',
    'Set to `production` by the pm2 entry and by `next build`/`next start`. Do not set it in the env file.', 'production'),
  same('NEXT_RUNTIME', 'runtime-set', 'runtime',
    'Injected by Next.js; instrumentation.ts only bootstraps the signing key when it is `nodejs`. Never set by hand.', '(set by Next.js)'),
  entry('LOG_LEVEL', 'optional', 'runtime',
    'pino log level for @ima-jin/logger (default info). Output is stdout only; pm2 captures it.',
    'debug', 'info'),
  unset('ENABLE_REQUEST_LOG', 'optional', 'runtime',
    'Logger request-log switch. Leave unset: this app wires no log sink (AGENTS.md — stdout only).'),
  unset('ENABLE_APP_LOG', 'optional', 'runtime',
    'Logger persisted-log switch. Leave unset: this app never persists logs to a database.'),
  unset('LOG_DB_TRANSPORT', 'optional', 'runtime',
    'Logger DB-transport switch. Leave unset: logging must never touch a data store (AGENTS.md).'),
  unset('APP_LOG_LEVEL', 'optional', 'runtime',
    'Minimum level the logger would persist (default warn). Inert while persistence is off.'),
  unset('ATTESTATION_INTERNAL_API_KEY', 'dependency', 'runtime',
    '@ima-jin/auth act-as / service attestation calls. learn attests with its own delegated app key instead; leave unset. Never hand-mint it.', { secret: true }),
  unset('AUTH_INTERNAL_API_KEY', 'dependency', 'runtime',
    'Deprecated @ima-jin/auth internal key (agent delegation). Not used by learn; leave unset.', { secret: true }),
  unset('PROFILE_INTERNAL_API_KEY', 'dependency', 'runtime',
    '@ima-jin/auth credential resolution key. learn holds no service-scope secret by design (emails are never released to it); leave unset.', { secret: true }),
  unset('NODE_DID', 'dependency', 'runtime',
    '@ima-jin/auth node-act-as check (kernel node DID). Not used by learn; leave unset.'),
  unset('APP_URL', 'dependency', 'runtime',
    '@ima-jin/auth fallback origin for redirects. learn does not rely on it; leave unset.'),
  unset('NEXT_PUBLIC_BASE_URL', 'dependency', 'runtime',
    '@ima-jin/auth fallback origin for redirects (after APP_URL). learn does not rely on it; leave unset.'),
  unset('REGISTRY_URL', 'dependency', 'runtime',
    'Deprecated alias of REGISTRY_SERVICE_URL read by @ima-jin/config. Leave unset; use REGISTRY_SERVICE_URL.'),
  unset('SESSION_COOKIE_SCOPE', 'dependency', 'runtime',
    '@ima-jin/config session-cookie scope switch (default host-only). Leave unset.'),
  unset('NEXT_PUBLIC_BUILD_HASH', 'dependency', 'build',
    '@ima-jin/ui footer build stamp. Cosmetic; leave unset.'),
  unset('NEXT_PUBLIC_COMMIT_COUNT', 'dependency', 'build',
    '@ima-jin/ui footer build stamp. Cosmetic; leave unset.'),
  unset('NEXT_PUBLIC_VERSION', 'dependency', 'build',
    '@ima-jin/ui footer version stamp. Cosmetic; leave unset.'),
  unset('NEXT_PUBLIC_NOTIFY_URL', 'dependency', 'build',
    '@ima-jin/ui notification widget endpoint. learn renders no such widget; leave unset.'),
  unset('MIGRATIONS_TEST_DATABASE_URL', 'optional', 'script',
    'CI/test only: a throwaway Postgres server the migration tests create scratch databases on. Never used in deployment.', { secret: true }),
];

export const ENV_VAR_NAMES = ENV_VARS.map((v) => v.name);

const PLACEHOLDER = /REPLACE_ME|CHANGE_ME/;
const MIN_SESSION_SECRET_LENGTH = 32;

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
}

function checkKernelUrl(name, value, target, errors) {
  const url = parseUrl(value);
  if (url === null || !/^https?:$/.test(url.protocol)) {
    errors.push(`${name} is not a valid http(s) URL.`);
    return;
  }
  if (isLocalHost(url.hostname)) {
    errors.push(`${name} points at localhost — a deployed ${target} instance must use the real kernel host.`);
    return;
  }
  const isDevHost = url.hostname.startsWith('dev-');
  if (target === 'prod' && isDevHost) {
    errors.push(`${name} points at a dev host (${url.hostname}) in a prod env file.`);
  }
  if (target === 'dev' && !isDevHost) {
    errors.push(`${name} points at a non-dev host (${url.hostname}) in a dev env file — dev must never talk to the prod kernel.`);
  }
}

function checkServicePrefix(name, value, prefix, errors) {
  if (value === '') return;
  const path = (parseUrl(value)?.pathname ?? '').replace(/\/$/, '');
  if (path !== prefix) {
    errors.push(`${name} must include the ${prefix} prefix (and nothing after it).`);
  }
}

const KERNEL_URL_VARS = [
  'IMAJIN_AUTH_URL',
  'NEXT_PUBLIC_IMAJIN_AUTH_URL',
  'IMAJIN_KERNEL_URL',
  'AUTH_SERVICE_URL',
  'REGISTRY_SERVICE_URL',
  'PROFILE_SERVICE_URL',
  'PAY_SERVICE_URL',
];

function checkIdentity(get, errors) {
  const did = get('IMAJIN_APP_DID');
  if (did !== '' && !did.startsWith('did:imajin:')) {
    errors.push('IMAJIN_APP_DID must start with did:imajin:.');
  }
  if (PLACEHOLDER.test(did)) {
    errors.push('IMAJIN_APP_DID is still a placeholder — mint the app identity first (docs/REGISTRATION.md).');
  }
  const appId = get('NEXT_PUBLIC_IMAJIN_APP_ID');
  if (appId !== '' && !appId.startsWith('app_')) {
    errors.push('NEXT_PUBLIC_IMAJIN_APP_ID must be the registry id (app_…).');
  }
  if (PLACEHOLDER.test(appId)) {
    errors.push('NEXT_PUBLIC_IMAJIN_APP_ID is still a placeholder — use the registry id from registration (docs/REGISTRATION.md).');
  }
  const secret = get('SESSION_SECRET');
  if (secret !== '' && (PLACEHOLDER.test(secret) || secret.length < MIN_SESSION_SECRET_LENGTH)) {
    errors.push(`SESSION_SECRET must be a real secret of at least ${MIN_SESSION_SECRET_LENGTH} characters (openssl rand -hex 32), not a placeholder.`);
  }
}

function checkKernelHosts(get, target, errors) {
  for (const name of KERNEL_URL_VARS) {
    if (get(name) !== '') checkKernelUrl(name, get(name), target, errors);
  }
  checkServicePrefix('AUTH_SERVICE_URL', get('AUTH_SERVICE_URL'), '/auth', errors);
  checkServicePrefix('REGISTRY_SERVICE_URL', get('REGISTRY_SERVICE_URL'), '/registry', errors);
  checkServicePrefix('PROFILE_SERVICE_URL', get('PROFILE_SERVICE_URL'), '/profile', errors);
  checkServicePrefix('PAY_SERVICE_URL', get('PAY_SERVICE_URL'), '/pay', errors);

  const hosts = new Set(KERNEL_URL_VARS.filter((name) => get(name) !== '').map((name) => parseUrl(get(name))?.host));
  if (hosts.size > 1) {
    errors.push('The kernel URLs (IMAJIN_AUTH_URL, NEXT_PUBLIC_IMAJIN_AUTH_URL, IMAJIN_KERNEL_URL and the *_SERVICE_URLs) must all point at the same kernel host.');
  }
  if (get('NEXT_PUBLIC_APP_URL') !== '') {
    checkKernelUrl('NEXT_PUBLIC_APP_URL', get('NEXT_PUBLIC_APP_URL'), target, errors);
  }
}

function checkTargetBinding(get, target, errors, warnings) {
  const imajinEnv = get('IMAJIN_ENV');
  if (target === 'dev' && imajinEnv !== 'dev') {
    errors.push('IMAJIN_ENV must be `dev` on the dev instance (selects the imajin_session_dev cookie).');
  }
  if (target === 'prod' && imajinEnv === 'dev') {
    errors.push('IMAJIN_ENV=dev must not be set on prod (it would read the dev session cookie).');
  }

  const wantPrefix = target === 'prod' ? 'https://' : 'https://dev-';
  const prefix = get('NEXT_PUBLIC_SERVICE_PREFIX');
  if (prefix !== '' && prefix !== wantPrefix) {
    errors.push(`NEXT_PUBLIC_SERVICE_PREFIX must be ${wantPrefix} on ${target}.`);
  }

  const port = get('PORT');
  if (port !== '' && port !== String(TARGETS[target].port)) {
    warnings.push(`PORT is set in the env file but ${TARGETS[target].name} runs on ${TARGETS[target].port}; the pm2 entry's value wins.`);
  }
  for (const name of ['ENABLE_APP_LOG', 'LOG_DB_TRANSPORT', 'ENABLE_REQUEST_LOG']) {
    if (get(name) === 'true') {
      warnings.push(`${name}=true — this app is stdout-logging only (AGENTS.md); leave it unset.`);
    }
  }
}

function checkPresence(get, errors) {
  for (const variable of ENV_VARS) {
    if (variable.status === 'required' && get(variable.name) === '') {
      errors.push(`${variable.name} is required but not set.`);
    }
    if (variable.status === 'forbidden' && get(variable.name) !== '') {
      errors.push(`${variable.name} must not be set (${variable.summary})`);
    }
  }
}

function checkFixedValues(get, errors) {
  const schema = get('APP_DB_SCHEMA');
  if (schema !== '' && schema !== 'learn') {
    errors.push('APP_DB_SCHEMA must be `learn` — the existing schema this app owns; renaming it orphans migration state.');
  }
  const basePath = get('NEXT_PUBLIC_BASE_PATH');
  if (basePath !== '' && basePath !== BASE_PATH) {
    errors.push(`NEXT_PUBLIC_BASE_PATH must be ${BASE_PATH}.`);
  }
}

function checkClaim(get, keystoreExists, errors, warnings) {
  const claimCode = get('IMAJIN_APP_CLAIM_CODE');
  if (claimCode !== '') {
    warnings.push('IMAJIN_APP_CLAIM_CODE is set — it is needed on the first boot only; remove it once the app has booted once.');
  } else if (keystoreExists === false) {
    errors.push(
      "No keystore found and IMAJIN_APP_CLAIM_CODE is not set — the first boot needs the one-time claim code from the operator's /jin approval card (docs/REGISTRATION.md).",
    );
  }
}

function checkDatabase(get, errors) {
  const databaseUrl = get('DATABASE_URL');
  if (databaseUrl !== '' && !/^postgres(ql)?:$/.test(parseUrl(databaseUrl)?.protocol ?? '')) {
    errors.push('DATABASE_URL must be a postgres:// or postgresql:// URL.');
  }
  if (PLACEHOLDER.test(databaseUrl)) {
    errors.push('DATABASE_URL still contains a placeholder password.');
  }
}

/**
 * Pure validation of a parsed env file for a deploy target. Returns
 * `{ errors, warnings }`; messages name variables, never values.
 *
 * `options.keystoreExists` (true/false, omit to skip the check): whether this
 * app's bootstrap keystore is already on disk. With no keystore the first
 * boot needs IMAJIN_APP_CLAIM_CODE, so the deploy fails here — before pm2 is
 * touched — instead of crash-looping at boot.
 * @param {Record<string, string | undefined>} env
 * @param {'prod' | 'dev'} target
 * @param {{ keystoreExists?: boolean }} [options]
 */
export function validateEnv(env, target, options = {}) {
  if (!(target in TARGETS)) {
    throw new Error(`Unknown target ${JSON.stringify(target)} — expected prod or dev.`);
  }
  const errors = [];
  const warnings = [];
  const get = (name) => (env[name] ?? '').trim();

  checkPresence(get, errors);
  checkDatabase(get, errors);

  checkFixedValues(get, errors);
  checkKernelHosts(get, target, errors);
  checkIdentity(get, errors);
  checkTargetBinding(get, target, errors, warnings);

  checkClaim(get, options.keystoreExists, errors, warnings);

  return { errors, warnings };
}

/**
 * Reads and parses an env file WITHOUT touching process.env.
 * @param {string} path
 */
export function readEnvFile(path) {
  return parseEnv(readFileSync(path, 'utf8'));
}
