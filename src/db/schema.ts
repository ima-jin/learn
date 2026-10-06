import {
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * This app owns exactly one Postgres schema, named by APP_DB_SCHEMA (`learn`).
 * It never creates tables outside this schema and never reads/writes a kernel
 * schema or another app's schema — see docs/MIGRATIONS.md.
 *
 * Ported from the kernel's shared migrations (ima-jin/imajin-ai
 * migrations/0001_seed.sql + 0018_learn_course_type.sql) with column-for-column
 * parity, so an existing `learn` schema can be adopted without data changes.
 */
const appSchemaName = process.env.APP_DB_SCHEMA;
if (!appSchemaName) {
  throw new Error('APP_DB_SCHEMA is not set — see .env.example and docs/MIGRATIONS.md.');
}

export const appSchema = pgSchema(appSchemaName);

/** Courses — top-level learning containers. */
export const courses = appSchema.table(
  'courses',
  {
    id: text('id').primaryKey(), // crs_xxx
    creatorDid: text('creator_did').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    slug: text('slug').unique(), // URL-friendly, /{handle}/{slug}
    price: integer('price').default(0), // cents (0 = free)
    currency: text('currency').default('CAD'),
    visibility: text('visibility').default('public'), // public / trust-bound / private
    imageUrl: text('image_url'),
    imageAssetId: text('image_asset_id'), // asset_xxx from the media service
    tags: jsonb('tags').default([]),
    metadata: jsonb('metadata').default({}),
    eventSlug: text('event_slug'), // linked event on the events app
    courseType: text('course_type').default('course'), // course / deck / workshop
    status: text('status').default('draft'), // draft / published / archived
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    creatorDidIdx: index('idx_learn_courses_creator_did').on(table.creatorDid),
    slugIdx: index('idx_learn_courses_slug').on(table.slug),
  }),
);

/** Modules — sections within a course. */
export const modules = appSchema.table(
  'modules',
  {
    id: text('id').primaryKey(), // mod_xxx
    courseId: text('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    courseIdIdx: index('idx_learn_modules_course_id').on(table.courseId),
  }),
);

/** Lessons — individual learning units within a module. */
export const lessons = appSchema.table(
  'lessons',
  {
    id: text('id').primaryKey(), // lsn_xxx
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    contentType: text('content_type').notNull().default('markdown'), // markdown / exercise / slide / video
    content: text('content'), // Markdown body
    durationMinutes: integer('duration_minutes'),
    sortOrder: integer('sort_order').notNull(),
    metadata: jsonb('metadata').default({}), // exercise instructions, video URL, etc.
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    moduleIdIdx: index('idx_learn_lessons_module_id').on(table.moduleId),
  }),
);

/** Enrollments — student <-> course relationship. */
export const enrollments = appSchema.table(
  'enrollments',
  {
    id: text('id').primaryKey(), // enr_xxx
    courseId: text('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    studentDid: text('student_did').notNull(),
    paymentId: text('payment_id'), // nullable — free courses
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    studentDidIdx: index('idx_learn_enrollments_student_did').on(table.studentDid),
    courseStudentUnique: uniqueIndex('idx_learn_enrollments_course_student').on(
      table.courseId,
      table.studentDid,
    ),
  }),
);

/** Lesson progress — per-lesson completion tracking. */
export const lessonProgress = appSchema.table(
  'lesson_progress',
  {
    enrollmentId: text('enrollment_id')
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    status: text('status').default('not_started'), // not_started / in_progress / completed
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.enrollmentId, table.lessonId] }),
  }),
);

export type Course = typeof courses.$inferSelect;
export type NewCourse = typeof courses.$inferInsert;
export type Module = typeof modules.$inferSelect;
export type NewModule = typeof modules.$inferInsert;
export type Lesson = typeof lessons.$inferSelect;
export type NewLesson = typeof lessons.$inferInsert;
export type Enrollment = typeof enrollments.$inferSelect;
export type NewEnrollment = typeof enrollments.$inferInsert;
export type LessonProgress = typeof lessonProgress.$inferSelect;
export type NewLessonProgress = typeof lessonProgress.$inferInsert;
