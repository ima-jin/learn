import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  appSchema,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
} from '../schema';

const EXPECTED_TABLES = ['courses', 'enrollments', 'lesson_progress', 'lessons', 'modules'];
const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

describe('learn schema', () => {
  const allTables = [courses, modules, lessons, enrollments, lessonProgress];

  it('is scoped to the APP_DB_SCHEMA postgres schema', () => {
    expect(appSchema.schemaName).toBe(process.env.APP_DB_SCHEMA);
  });

  it('defines exactly the five learn tables, all inside the app schema', () => {
    const configs = allTables.map((table) => getTableConfig(table));
    expect(configs.map((config) => config.name).sort((a, b) => a.localeCompare(b))).toEqual(
      EXPECTED_TABLES,
    );
    for (const config of configs) {
      expect(config.schema).toBe(appSchema.schemaName);
    }
  });

  it('cascades deletes down the course -> module -> lesson -> progress chain', () => {
    const cascades = allTables.flatMap((table) =>
      getTableConfig(table).foreignKeys.map((fk) => fk.onDelete),
    );
    expect(cascades).toHaveLength(5);
    expect(new Set(cascades)).toEqual(new Set(['cascade']));
  });

  it('enforces one enrollment per student per course', () => {
    const indexes = getTableConfig(enrollments).indexes.map((index) => index.config);
    const unique = indexes.find((index) => index.name === 'idx_learn_enrollments_course_student');
    expect(unique?.unique).toBe(true);
  });
});

describe('learn migrations', () => {
  const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'));
  const statements = sqlFiles.flatMap((file) =>
    readFileSync(join(MIGRATIONS_DIR, file), 'utf-8')
      .split(STATEMENT_BREAKPOINT)
      .map((statement) => statement.trim())
      .filter(Boolean),
  );

  it('has at least one migration', () => {
    expect(sqlFiles.length).toBeGreaterThan(0);
  });

  it('creates the learn schema idempotently, before any table', () => {
    expect(statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS "learn";');
  });

  it('only ever touches objects qualified with the learn schema', () => {
    const [, ...rest] = statements;
    for (const statement of rest) {
      expect(statement).toContain('"learn".');
      expect(statement).not.toContain('"public".');
    }
  });

  it('creates every learn table', () => {
    for (const table of EXPECTED_TABLES) {
      expect(statements.some((s) => s.startsWith(`CREATE TABLE "learn"."${table}"`))).toBe(true);
    }
  });
});
