#!/usr/bin/env node
/**
 * Deploy preflight: validates an env file for a deploy target.
 *
 *   node scripts/check-env.mjs <prod|dev> [--file <path>]   (default .env.local)
 *
 * Prints variable NAMES only — never values. Exit 0 = ok (warnings allowed),
 * 1 = invalid, 2 = usage/IO error. See docs/ENVIRONMENTS.md.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEnvFile, TARGETS, validateEnv } from './lib/env-manifest.mjs';

function parseArgs(argv) {
  const [target, ...rest] = argv;
  let envFile = '.env.local';
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--file' && rest[i + 1] !== undefined) {
      envFile = rest[i + 1];
      i += 1;
    } else {
      return null;
    }
  }
  return target in TARGETS ? { target, envFile } : null;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args === null) {
    console.error('Usage: check-env.mjs <prod|dev> [--file <path>]');
    return 2;
  }
  if (!existsSync(args.envFile)) {
    console.error(`Env file not found: ${args.envFile} — see docs/ENVIRONMENTS.md.`);
    return 2;
  }

  const env = readEnvFile(args.envFile);
  // Default keystore location mirrors @ima-jin/auth-client: ./.imajin/keystore.json
  // relative to the process cwd (pm2 runs from the repo root, as does deploy.sh).
  const keystorePath = resolve(env.IMAJIN_APP_KEYSTORE?.trim() || '.imajin/keystore.json');
  const { errors, warnings } = validateEnv(env, args.target, { keystoreExists: existsSync(keystorePath) });
  for (const warning of warnings) console.warn(`warn:  ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);
  if (errors.length > 0) {
    console.error(`\n${args.envFile} is not valid for ${args.target} (${errors.length} error(s)).`);
    return 1;
  }
  console.log(`${args.envFile} is valid for ${args.target}.`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
