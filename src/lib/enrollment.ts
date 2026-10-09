import { and, eq } from 'drizzle-orm';
import { db, enrollments, lessonProgress, lessons, modules } from '@/db';
import type { Enrollment } from '@/db/schema';
import { generateId } from '@/lib/utils';

export interface EnrollStudentInput {
  courseId: string;
  studentDid: string;
  /** The payment that bought the enrollment; null for a free course. */
  paymentId: string | null;
}

export interface EnrollStudentResult {
  enrollment: Enrollment;
  /** False when the student was already enrolled — a replay, nothing was written. */
  created: boolean;
}

/**
 * Enroll a student in a course and seed `not_started` progress for every lesson, idempotently.
 *
 * Idempotent on (course, student): the unique index `idx_learn_enrollments_course_student` makes a second
 * insert a no-op, so a redelivered payment notification — or a double click racing the first request —
 * returns the existing enrollment instead of creating a duplicate. The enrollment and its progress rows
 * are written in one transaction, so a replay can never find an enrollment without progress.
 */
export function enrollStudent(input: EnrollStudentInput): Promise<EnrollStudentResult> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(enrollments)
      .values({
        id: generateId('enr'),
        courseId: input.courseId,
        studentDid: input.studentDid,
        paymentId: input.paymentId,
      })
      .onConflictDoNothing({ target: [enrollments.courseId, enrollments.studentDid] })
      .returning();

    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(enrollments)
        .where(and(eq(enrollments.courseId, input.courseId), eq(enrollments.studentDid, input.studentDid)))
        .limit(1);
      if (!existing) throw new Error('Enrollment vanished while enrolling');
      return { enrollment: existing, created: false };
    }

    const courseLessons = await tx
      .select({ id: lessons.id })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(eq(modules.courseId, input.courseId));
    if (courseLessons.length > 0) {
      await tx.insert(lessonProgress).values(
        courseLessons.map((lesson) => ({
          enrollmentId: inserted.id,
          lessonId: lesson.id,
          status: 'not_started',
        })),
      );
    }

    return { enrollment: inserted, created: true };
  });
}
