import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { courses, enrollments, lessons, modules } from '@/db/schema';

export type Course = typeof courses.$inferSelect;

export async function getCourseBySlug(slug: string): Promise<Course | null> {
  const result = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  return result[0] ?? null;
}

/** A lesson, only if it sits in the given module of the given course. */
export async function getLessonInCourse(courseId: string, moduleId: string, lessonId: string) {
  const rows = await db
    .select({ lesson: lessons })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(and(eq(lessons.id, lessonId), eq(lessons.moduleId, moduleId), eq(modules.courseId, courseId)))
    .limit(1);
  return rows[0]?.lesson ?? null;
}

/** A module, only if it belongs to the given course. */
export async function getModuleInCourse(courseId: string, moduleId: string) {
  const rows = await db
    .select()
    .from(modules)
    .where(and(eq(modules.id, moduleId), eq(modules.courseId, courseId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function isEnrolled(courseId: string, studentDid: string): Promise<boolean> {
  const rows = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(eq(enrollments.courseId, courseId), eq(enrollments.studentDid, studentDid)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Lesson-content access for a caller:
 *  - `creator`  — the course's own creator (always full access)
 *  - `open`     — a free course, content is readable
 *  - `enrolled` — a paid course the caller is enrolled in
 *  - `locked`   — a paid course, caller is anonymous or not enrolled
 *  - `hidden`   — a private course, caller is not the creator (indistinguishable from not found)
 */
export type ContentAccess = 'creator' | 'open' | 'enrolled' | 'locked' | 'hidden';

export async function resolveContentAccess(course: Course, callerDid: string | null): Promise<ContentAccess> {
  if (callerDid && callerDid === course.creatorDid) return 'creator';
  if (course.visibility === 'private') return 'hidden';
  if (!course.price || course.price <= 0) return 'open';
  if (callerDid && (await isEnrolled(course.id, callerDid))) return 'enrolled';
  return 'locked';
}
