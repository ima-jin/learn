import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertIdentifier,
  BaselineMismatchError,
  compareSchema,
  expectedSchema,
  readBaselineMigration,
  runBaseline,
} from '../lib/migrate-baseline-core.mjs';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));
const CLI = fileURLToPath(new URL('../migrate-baseline.mjs', import.meta.url));
const BASELINE_SQL_FILE = `${MIGRATIONS_FOLDER}/0000_learn_schema.sql`;
const SCHEMA = 'learn';
const TRACKING = '"learn"."__drizzle_migrations"';
const MIGRATE_CONFIG = { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: SCHEMA, migrationsTable: '__drizzle_migrations' };

type RunnerSql = Parameters<typeof runBaseline>[0];
type Options = { dryRun?: boolean };

/** Minimal child env — never inherits the caller's DATABASE_URL & friends. */
function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv;
}

describe('assertIdentifier', () => {
  it('accepts plain lower-case identifiers', () => {
    expect(assertIdentifier('learn', 'x')).toBe('learn');
    expect(assertIdentifier('app_learn_2', 'x')).toBe('app_learn_2');
  });

  it.each(['', 'Learn', 'learn; DROP SCHEMA learn', 'a"b', '1learn', 'a-b'])('rejects %j', (value) => {
    expect(() => assertIdentifier(value, 'APP_DB_SCHEMA')).toThrow(/APP_DB_SCHEMA must match/);
  });
});

describe('readBaselineMigration', () => {
  it('hashes the first journal entry exactly like drizzle-orm does', async () => {
    const baseline = await readBaselineMigration(MIGRATIONS_FOLDER);
    const [drizzleFirst] = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

    expect(baseline.hash).toBe(drizzleFirst.hash);
    expect(baseline.when).toBe(drizzleFirst.folderMillis);
    expect(baseline.hash).toBe(createHash('sha256').update(readFileSync(BASELINE_SQL_FILE, 'utf8')).digest('hex'));
  });
});

describe('compareSchema', () => {
  const fresh = () => structuredClone(expectedSchema(SCHEMA));

  it('accepts an identical schema', () => {
    expect(compareSchema(fresh(), expectedSchema(SCHEMA))).toEqual([]);
  });

  it('tolerates extra indexes (harmless)', () => {
    const actual = fresh();
    actual.courses.indexes.push({ name: 'idx_extra', columns: ['title'], method: 'btree' });
    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual([]);
  });

  it('reports a missing table', () => {
    const actual = fresh() as Record<string, unknown>;
    delete actual.lesson_progress;
    expect(compareSchema(actual as ReturnType<typeof expectedSchema>, expectedSchema(SCHEMA))).toEqual([
      'lesson_progress: table is missing',
    ]);
  });

  it('reports an unexpected table', () => {
    const actual = { ...fresh(), stray: structuredClone(fresh().modules) };
    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual(['stray: unexpected table in the app schema']);
  });

  it('reports missing, extra, retyped, nullability and default drift on columns', () => {
    const actual = fresh();
    delete (actual.courses.columns as Record<string, unknown>).course_type;
    (actual.courses.columns as Record<string, unknown>).surprise = { type: 'text', notNull: false, default: null };
    actual.lessons.columns.title.type = 'character varying(255)';
    actual.lessons.columns.title.notNull = false;
    actual.courses.columns.price.default = null;

    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual([
      'courses.price: default is none, expected 0',
      'courses.course_type: column is missing',
      'courses.surprise: unexpected column',
      'lessons.title: type is character varying(255), expected text',
      'lessons.title: NOT NULL is false, expected true',
    ]);
  });

  it('reports key, FK and index drift', () => {
    const actual = fresh();
    actual.courses.primaryKey = ['slug'];
    actual.courses.unique = [];
    actual.modules.foreignKeys[0].onDelete = 'no action';
    actual.enrollments.indexes = [];

    const problems = compareSchema(actual, expectedSchema(SCHEMA)).join('\n');
    expect(problems).toMatch(/courses: primary key is \(slug\), expected \(id\)/);
    expect(problems).toMatch(/courses: unique constraints/);
    expect(problems).toMatch(/modules: foreign keys/);
    expect(problems).toMatch(/enrollments: index idx_learn_enrollments_student_did is missing/);
    expect(problems).toMatch(/enrollments: index idx_learn_enrollments_course_student is missing/);
  });

  it('reports a reshaped index', () => {
    const actual = fresh();
    actual.enrollments.indexes[1].columns = ['course_id'];
    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual([
      'enrollments: index idx_learn_enrollments_course_student is btree(course_id), expected btree(course_id, student_did)',
    ]);
  });
});

/**
 * The shape the monorepo's shared seed (imajin-ai migrations/0001_seed.sql +
 * 0018_learn_course_type.sql) left in prod/dev: same tables and constraints as
 * this repo's migration 0000, but built by ALTERs, so column order differs
 * (course_type / image_asset_id are last on `courses`).
 */
const PROD_LIKE_SCHEMA_SQL = [
  'CREATE SCHEMA IF NOT EXISTS learn',
  `CREATE TABLE learn.courses (
    id text NOT NULL, creator_did text NOT NULL, title text NOT NULL, description text,
    slug text, price integer DEFAULT 0, currency text DEFAULT 'CAD'::text,
    visibility text DEFAULT 'public'::text, image_url text,
    tags jsonb DEFAULT '[]'::jsonb, metadata jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'draft'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    event_slug text, course_type text DEFAULT 'course'::text, image_asset_id text)`,
  `CREATE TABLE learn.modules (
    id text NOT NULL, course_id text NOT NULL, title text NOT NULL, description text,
    sort_order integer NOT NULL, created_at timestamp with time zone DEFAULT now())`,
  `CREATE TABLE learn.lessons (
    id text NOT NULL, module_id text NOT NULL, title text NOT NULL,
    content_type text DEFAULT 'markdown'::text NOT NULL, content text,
    duration_minutes integer, sort_order integer NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now())`,
  `CREATE TABLE learn.enrollments (
    id text NOT NULL, course_id text NOT NULL, student_did text NOT NULL, payment_id text,
    enrolled_at timestamp with time zone DEFAULT now(), completed_at timestamp with time zone)`,
  `CREATE TABLE learn.lesson_progress (
    enrollment_id text NOT NULL, lesson_id text NOT NULL,
    status text DEFAULT 'not_started'::text, completed_at timestamp with time zone)`,
  'ALTER TABLE ONLY learn.courses ADD CONSTRAINT courses_pkey PRIMARY KEY (id)',
  'ALTER TABLE ONLY learn.courses ADD CONSTRAINT courses_slug_unique UNIQUE (slug)',
  'ALTER TABLE ONLY learn.enrollments ADD CONSTRAINT enrollments_pkey PRIMARY KEY (id)',
  'ALTER TABLE ONLY learn.lesson_progress ADD CONSTRAINT lesson_progress_enrollment_id_lesson_id_pk PRIMARY KEY (enrollment_id, lesson_id)',
  'ALTER TABLE ONLY learn.lessons ADD CONSTRAINT lessons_pkey PRIMARY KEY (id)',
  'ALTER TABLE ONLY learn.modules ADD CONSTRAINT modules_pkey PRIMARY KEY (id)',
  'CREATE INDEX idx_learn_courses_creator_did ON learn.courses USING btree (creator_did)',
  'CREATE INDEX idx_learn_courses_slug ON learn.courses USING btree (slug)',
  'CREATE UNIQUE INDEX idx_learn_enrollments_course_student ON learn.enrollments USING btree (course_id, student_did)',
  'CREATE INDEX idx_learn_enrollments_student_did ON learn.enrollments USING btree (student_did)',
  'CREATE INDEX idx_learn_lessons_module_id ON learn.lessons USING btree (module_id)',
  'CREATE INDEX idx_learn_modules_course_id ON learn.modules USING btree (course_id)',
  `ALTER TABLE ONLY learn.enrollments ADD CONSTRAINT enrollments_course_id_courses_id_fk
     FOREIGN KEY (course_id) REFERENCES learn.courses(id) ON DELETE CASCADE`,
  `ALTER TABLE ONLY learn.lesson_progress ADD CONSTRAINT lesson_progress_enrollment_id_enrollments_id_fk
     FOREIGN KEY (enrollment_id) REFERENCES learn.enrollments(id) ON DELETE CASCADE`,
  `ALTER TABLE ONLY learn.lesson_progress ADD CONSTRAINT lesson_progress_lesson_id_lessons_id_fk
     FOREIGN KEY (lesson_id) REFERENCES learn.lessons(id) ON DELETE CASCADE`,
  `ALTER TABLE ONLY learn.lessons ADD CONSTRAINT lessons_module_id_modules_id_fk
     FOREIGN KEY (module_id) REFERENCES learn.modules(id) ON DELETE CASCADE`,
  `ALTER TABLE ONLY learn.modules ADD CONSTRAINT modules_course_id_courses_id_fk
     FOREIGN KEY (course_id) REFERENCES learn.courses(id) ON DELETE CASCADE`,
];

const SEED_ROWS_SQL = [
  `INSERT INTO learn.courses (id, creator_did, title, slug) VALUES ('c1', 'did:imajin:a', 'Intro', 'intro')`,
  `INSERT INTO learn.modules (id, course_id, title, sort_order) VALUES ('m1', 'c1', 'Mod', 0)`,
  `INSERT INTO learn.lessons (id, module_id, title, sort_order) VALUES ('l1', 'm1', 'Lesson', 0)`,
  `INSERT INTO learn.enrollments (id, course_id, student_did) VALUES ('e1', 'c1', 'did:imajin:s')`,
  `INSERT INTO learn.lesson_progress (enrollment_id, lesson_id) VALUES ('e1', 'l1')`,
];

const ROW_COUNTS_SQL = `SELECT (SELECT count(*) FROM learn.courses)::int AS courses,
  (SELECT count(*) FROM learn.modules)::int AS modules,
  (SELECT count(*) FROM learn.lessons)::int AS lessons,
  (SELECT count(*) FROM learn.enrollments)::int AS enrollments,
  (SELECT count(*) FROM learn.lesson_progress)::int AS lesson_progress`;
const SEEDED_COUNTS = { courses: 1, modules: 1, lessons: 1, enrollments: 1, lesson_progress: 1 };

const isRead = (statement: string) => /^\s*(SELECT|WITH)\b/i.test(statement);

describe('migrate-baseline (in-process Postgres)', () => {
  const client = new PGlite();
  afterAll(() => client.close());

  /** Adapts PGlite to the `begin` + `unsafe` surface the runner needs; audits every statement. */
  function runner(statements: string[] = []) {
    return {
      begin: (fn: (tx: unknown) => Promise<unknown>) =>
        client.transaction((tx) =>
          fn({
            unsafe: async (text: string, params: unknown[] = []) => {
              statements.push(text);
              return (await tx.query(text, params)).rows;
            },
          }),
        ),
    } as unknown as RunnerSql;
  }

  const run = (options: Options = {}, statements: string[] = []) =>
    runBaseline(runner(statements), { schema: SCHEMA, migrationsFolder: MIGRATIONS_FOLDER, ...options });

  const query = async <T = Record<string, unknown>>(text: string) => (await client.query<T>(text)).rows;
  const rowCounts = async () => (await query(ROW_COUNTS_SQL))[0];
  const trackingRows = () => query<{ hash: string; created_at: string | number | bigint }>(`SELECT hash, created_at FROM ${TRACKING} ORDER BY id`);
  async function trackingExists() {
    const [row] = await query<{ present: boolean }>(`SELECT to_regclass('${TRACKING}') IS NOT NULL AS present`);
    return row.present;
  }

  async function seedProdLike() {
    for (const statement of PROD_LIKE_SCHEMA_SQL) await client.query(statement);
    for (const statement of SEED_ROWS_SQL) await client.query(statement);
  }

  beforeEach(async () => {
    await client.exec('DROP SCHEMA IF EXISTS learn CASCADE');
  });

  describe('baselining an existing, prod-shaped schema', () => {
    it('records migration 0000 and leaves every table and row untouched', async () => {
      await seedProdLike();
      const expected = await readBaselineMigration(MIGRATIONS_FOLDER);

      const result = await run();

      expect(result).toEqual({ status: 'baselined', tag: expected.tag });
      expect(await rowCounts()).toEqual(SEEDED_COUNTS);
      const rows = await trackingRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].hash).toBe(expected.hash);
      expect(Number(rows[0].created_at)).toBe(expected.when);
    });

    it('is idempotent — a second and third run change nothing', async () => {
      await seedProdLike();
      await run();

      const second = await run();
      const third = await run();

      expect(second.status).toBe('already-baselined');
      expect(third.status).toBe('already-baselined');
      expect(await trackingRows()).toHaveLength(1);
      expect(await rowCounts()).toEqual(SEEDED_COUNTS);
    });

    it('leaves drizzle migrate a clean no-op afterwards (no CREATE TABLE collision)', async () => {
      await seedProdLike();
      await run();

      await migrate(drizzle(client), MIGRATE_CONFIG);

      expect(await rowCounts()).toEqual(SEEDED_COUNTS);
      expect(await trackingRows()).toHaveLength(1);
    });

    it('without the baseline, migrate fails on the existing schema (why this runner exists)', async () => {
      await seedProdLike();
      await expect(migrate(drizzle(client), MIGRATE_CONFIG)).rejects.toThrow();
    });

    it('accepts a schema produced by migration 0000 itself (expectation cannot drift from the SQL)', async () => {
      await migrate(drizzle(client), MIGRATE_CONFIG);
      expect((await run()).status).toBe('already-baselined');

      // Same schema, but the journal is gone: it must validate and re-baseline.
      await client.exec(`DROP TABLE ${TRACKING}`);
      expect((await run()).status).toBe('baselined');
      expect(await trackingRows()).toHaveLength(1);
    });

    it('accepts an existing-but-empty journal table (drizzle created it first)', async () => {
      await seedProdLike();
      await client.exec(`CREATE TABLE ${TRACKING} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);

      expect((await run()).status).toBe('baselined');
    });

    it('dry run validates but writes nothing', async () => {
      await seedProdLike();

      const result = await run({ dryRun: true });

      expect(result.status).toBe('would-baseline');
      expect(await trackingExists()).toBe(false);
    });
  });

  describe('fresh database', () => {
    it('does nothing and creates nothing, leaving the schema to db:migrate', async () => {
      const statements: string[] = [];

      const result = await run({}, statements);

      expect(result.status).toBe('fresh-database');
      expect(statements.filter((s) => !isRead(s))).toEqual([]);
      const [{ n }] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'learn'`);
      expect(n).toBe(0);

      await migrate(drizzle(client), MIGRATE_CONFIG);
      expect((await run()).status).toBe('already-baselined');
    });
  });

  describe('refuses on mismatch', () => {
    async function expectRefusal(pattern: RegExp) {
      const before = await rowCounts();
      await expect(run()).rejects.toBeInstanceOf(BaselineMismatchError);
      await expect(run()).rejects.toThrow(pattern);
      expect(await trackingExists()).toBe(false);
      expect(await rowCounts()).toEqual(before);
    }

    it('when a column is missing', async () => {
      await seedProdLike();
      await client.exec('ALTER TABLE learn.courses DROP COLUMN course_type');
      await expectRefusal(/courses\.course_type: column is missing/);
    });

    it('when a column has an unexpected type', async () => {
      await seedProdLike();
      await client.exec('ALTER TABLE learn.lessons ALTER COLUMN title TYPE varchar(100)');
      await expectRefusal(/lessons\.title: type is character varying\(100\), expected text/);
    });

    it('when a column has an unexpected default', async () => {
      await seedProdLike();
      await client.exec(`ALTER TABLE learn.courses ALTER COLUMN currency SET DEFAULT 'USD'`);
      await expectRefusal(/courses\.currency: default is 'USD'::text, expected 'CAD'::text/);
    });

    it('when an unknown table lives in the app schema', async () => {
      await seedProdLike();
      await client.exec('CREATE TABLE learn.stray (id text)');
      await expectRefusal(/stray: unexpected table/);
    });

    it('when a foreign key is missing', async () => {
      await seedProdLike();
      await client.exec('ALTER TABLE learn.modules DROP CONSTRAINT modules_course_id_courses_id_fk');
      await expectRefusal(/modules: foreign keys/);
    });

    it('when the unique enrollment index is missing', async () => {
      await seedProdLike();
      await client.exec('DROP INDEX learn.idx_learn_enrollments_course_student');
      await expectRefusal(/idx_learn_enrollments_course_student is missing/);
    });

    it('when the schema exists but is empty', async () => {
      await client.exec('CREATE SCHEMA learn');
      await expect(run()).rejects.toThrow(/courses: table is missing/);
      expect(await trackingExists()).toBe(false);
    });

    it('when the journal holds history that does not include migration 0000', async () => {
      await seedProdLike();
      await client.exec(`CREATE TABLE ${TRACKING} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
      await client.exec(`INSERT INTO ${TRACKING} (hash, created_at) VALUES ('someone-elses-hash', 1)`);

      await expect(run()).rejects.toThrow(/unrecognised migration history/);
      expect(await trackingRows()).toHaveLength(1);
    });

    it('when APP_DB_SCHEMA is not a safe identifier', () => {
      expect(() =>
        runBaseline(runner(), { schema: 'learn; DROP SCHEMA learn', migrationsFolder: MIGRATIONS_FOLDER }),
      ).toThrow(/APP_DB_SCHEMA must match/);
    });
  });

  describe('never drops, truncates, or alters anything', () => {
    const DESTRUCTIVE = /\b(DROP|TRUNCATE|ALTER|DELETE|UPDATE|GRANT|REVOKE|RENAME)\b/i;
    const APP_TABLES = /\b(courses|modules|lessons|enrollments|lesson_progress)\b/i;

    it('only ever issues SELECTs plus create-only bookkeeping DDL (successful run)', async () => {
      await seedProdLike();
      const statements: string[] = [];

      await run({}, statements);

      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).not.toMatch(DESTRUCTIVE);
        expect(statement).not.toMatch(APP_TABLES);
      }
      const writes = statements.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s));
      expect(writes).toHaveLength(3);
      expect(writes[0]).toMatch(/^CREATE SCHEMA IF NOT EXISTS "learn"$/);
      expect(writes[1]).toMatch(/^CREATE TABLE IF NOT EXISTS "learn"\."__drizzle_migrations"/);
      expect(writes[2]).toMatch(/^INSERT INTO "learn"\."__drizzle_migrations"/);
    });

    it('issues no write at all when it refuses', async () => {
      await seedProdLike();
      await client.exec('ALTER TABLE learn.courses DROP COLUMN description');
      const statements: string[] = [];

      await expect(run({}, statements)).rejects.toBeInstanceOf(BaselineMismatchError);

      expect(statements.filter((s) => !isRead(s))).toEqual([]);
    });

    it('issues no write at all on a re-run or a dry run', async () => {
      await seedProdLike();
      const dryRun: string[] = [];
      await run({ dryRun: true }, dryRun);
      await run();
      const rerun: string[] = [];
      await run({}, rerun);

      expect(dryRun.filter((s) => !isRead(s))).toEqual([]);
      expect(rerun.filter((s) => !isRead(s))).toEqual([]);
    });
  });
});

describe('migrate-baseline CLI configuration errors (no database needed)', () => {
  const cli = (env: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, [CLI, ...args], { env: childEnv(env), encoding: 'utf8' });

  it('exits 2 when DATABASE_URL is missing', () => {
    const result = cli({});
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/DATABASE_URL is not set/);
  });

  it('exits 2 on an unknown argument', () => {
    const result = cli({ DATABASE_URL: 'postgres://127.0.0.1:1/x' }, ['--force']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Unknown argument/);
  });

  it('exits 2 on an unsafe APP_DB_SCHEMA before touching the database', () => {
    const result = cli({ DATABASE_URL: 'postgres://127.0.0.1:1/x', APP_DB_SCHEMA: 'x; DROP SCHEMA y' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/APP_DB_SCHEMA must match/);
  });
});

// The CLI talks to a real server over postgres.js. CI's `migrations` job provides one.
const databaseUrl = process.env.MIGRATIONS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('migrate-baseline CLI against a real Postgres', () => {
  let admin: postgres.Sql;
  let dbName: string;
  let url: string;
  let sql: postgres.Sql;

  beforeEach(async () => {
    admin = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
    dbName = `learn_baseline_${randomBytes(6).toString('hex')}`;
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const parsed = new URL(databaseUrl as string);
    parsed.pathname = `/${dbName}`;
    url = parsed.toString();
    sql = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterEach(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  async function seedProdLike() {
    for (const statement of [...PROD_LIKE_SCHEMA_SQL, ...SEED_ROWS_SQL]) await sql.unsafe(statement);
  }

  const cli = (env: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, [CLI, ...args], { env: childEnv(env), encoding: 'utf8' });

  async function trackingPresent() {
    const [row] = await sql.unsafe(`SELECT to_regclass('${TRACKING}') IS NOT NULL AS present`);
    return row.present as boolean;
  }

  it('exits 0 on baseline, then 0 again (idempotent), without echoing the connection string', async () => {
    await seedProdLike();

    const first = cli({ DATABASE_URL: url });
    const second = cli({ DATABASE_URL: url });

    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/Baselined: recorded 0000_/);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/Already baselined/);
    const output = first.stdout + first.stderr + second.stdout + second.stderr;
    expect(output).not.toContain(url);
    const [counts] = await sql.unsafe(ROW_COUNTS_SQL);
    expect(counts).toEqual(SEEDED_COUNTS);
  });

  it('exits 1 with a clear error on mismatch and changes nothing', async () => {
    await seedProdLike();
    await sql.unsafe('ALTER TABLE learn.courses DROP COLUMN description');

    const result = cli({ DATABASE_URL: url });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refusing to baseline/);
    expect(result.stderr).toMatch(/courses\.description: column is missing/);
    expect(await trackingPresent()).toBe(false);
  });

  it('--dry-run exits 0 and writes nothing', async () => {
    await seedProdLike();

    const result = cli({ DATABASE_URL: url }, ['--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Dry run/);
    expect(await trackingPresent()).toBe(false);
  });

  it('treats a database with no learn schema as fresh', () => {
    const result = cli({ DATABASE_URL: url });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Fresh database/);
  });
});
