import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs only when MIGRATIONS_TEST_DATABASE_URL points at a Postgres that
 * `pnpm db:migrate` has already been run against (the CI `migrations` job does
 * exactly that). Skipped locally and in the plain unit-test job.
 */
const databaseUrl = process.env.MIGRATIONS_TEST_DATABASE_URL;
const schemaName = process.env.APP_DB_SCHEMA ?? 'learn';

describe.skipIf(!databaseUrl)('migration runner (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(databaseUrl as string, { max: 1, onnotice: () => undefined });
  });

  afterAll(async () => {
    await sql.end();
  });

  it('creates the learn schema and all five tables in it', async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = ${schemaName} and table_type = 'BASE TABLE'
      order by table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      '__drizzle_migrations',
      'courses',
      'enrollments',
      'lesson_progress',
      'lessons',
      'modules',
    ]);
  });

  it('creates no objects outside the learn schema', async () => {
    const rows = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace
      where nspname not like 'pg\_%' and nspname <> 'information_schema'
      order by nspname`;
    const names = rows.map((row) => row.nspname);
    expect(names).toContain(schemaName);
    expect(names).not.toContain('drizzle');

    const publicTables = await sql`
      select 1 from information_schema.tables where table_schema = 'public'`;
    expect(publicTables).toHaveLength(0);
  });

  it('enforces FKs, cascades and the one-enrollment-per-student rule', async () => {
    const s = sql(schemaName);
    await sql`insert into ${s}.courses (id, creator_did, title) values ('crs_t', 'did:imajin:a', 'T')`;
    await sql`insert into ${s}.modules (id, course_id, title, sort_order) values ('mod_t', 'crs_t', 'M', 1)`;
    await sql`insert into ${s}.lessons (id, module_id, title, sort_order) values ('lsn_t', 'mod_t', 'L', 1)`;
    await sql`insert into ${s}.enrollments (id, course_id, student_did) values ('enr_t', 'crs_t', 'did:imajin:b')`;
    await sql`insert into ${s}.lesson_progress (enrollment_id, lesson_id) values ('enr_t', 'lsn_t')`;

    await expect(
      sql`insert into ${s}.enrollments (id, course_id, student_did) values ('enr_u', 'crs_t', 'did:imajin:b')`,
    ).rejects.toThrow();

    const [defaults] = await sql<{ status: string; course_type: string; price: number }[]>`
      select status, course_type, price from ${s}.courses where id = 'crs_t'`;
    expect(defaults).toEqual({ status: 'draft', course_type: 'course', price: 0 });

    await sql`delete from ${s}.courses where id = 'crs_t'`;
    for (const table of ['modules', 'lessons', 'enrollments', 'lesson_progress']) {
      const [{ count }] = await sql<{ count: string }[]>`select count(*) from ${s}.${sql(table)}`;
      expect(count).toBe('0');
    }
  });
});
