import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Route tests run real SQL: the exact `@/db` import resolves to an
      // in-process Postgres (PGlite) with this repo's real migrations applied
      // (test/stubs/db.ts). `@/db/schema` still resolves to the real schema.
      { find: /^@\/db$/, replacement: fileURLToPath(new URL('./test/stubs/db.ts', import.meta.url)) },
      { find: /^@test\//, replacement: fileURLToPath(new URL('./test/', import.meta.url)) },
      { find: /^@\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
      // @ima-jin/auth-client transitively imports 'next/headers' (getSession's
      // cookie read) — not resolvable under plain-Node vitest, only inside a
      // real Next.js runtime. See test/stubs/next-headers.ts.
      { find: 'next/headers', replacement: fileURLToPath(new URL('./test/stubs/next-headers.ts', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    // src/db/schema.ts binds every table to APP_DB_SCHEMA at import time.
    env: {
      APP_DB_SCHEMA: process.env.APP_DB_SCHEMA ?? 'learn',
      // Fake-kernel endpoints (test/kernel.ts) — never real services.
      AUTH_SERVICE_URL: 'https://kernel.test/auth',
      NEXT_PUBLIC_APP_URL: 'https://learn.test',
      PAY_SERVICE_URL: 'https://kernel.test/pay',
      REGISTRY_SERVICE_URL: 'https://kernel.test/registry',
      PROFILE_SERVICE_URL: 'https://kernel.test/profile',
    },
    include: ['**/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
    server: {
      // Otherwise vitest hands @ima-jin/auth-client's ESM import of
      // 'next/headers' straight to Node's own resolver, which bypasses
      // resolve.alias above and can't find it outside a real Next.js runtime.
      deps: {
        // Same reason for the other @ima-jin/* SDK packages: they import
        // 'next/server' extensionlessly, which Node's own ESM resolver rejects.
        inline: ['@ima-jin/auth-client', '@ima-jin/auth', '@ima-jin/config', '@ima-jin/fair', '@ima-jin/logger'],
      },
    },
    coverage: {
      // lcov is what SonarCloud ingests (sonar.javascript.lcov.reportPaths).
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['app/**/*.ts', 'app/**/*.tsx', 'src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.d.ts',
        '**/.next/**',
        '**/node_modules/**',
      ],
    },
  },
});
