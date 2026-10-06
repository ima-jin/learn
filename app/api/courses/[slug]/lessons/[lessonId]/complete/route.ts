import { NextRequest } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { enrollments, lessonProgress, lessons, modules } from '@/db/schema';
import { authenticate } from '@/lib/auth/authenticate';
import { getCourseBySlug } from '@/lib/course-access';
import { emitLearnEvent } from '@/lib/events';
import { errorResponse, jsonResponse } from '@/lib/utils';

type RouteParams = { params: Promise<{ slug: string; lessonId: string }> };

/**
 * POST /api/courses/[slug]/lessons/[lessonId]/complete — Mark lesson complete
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { slug, lessonId } = await params;

  const authResult = await authenticate(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const { auth } = authResult;
  const did = auth.did;

  const course = await getCourseBySlug(slug);
  if (!course) return errorResponse('Course not found', 404);

  // Verify enrollment
  const enrollResult = await db.select().from(enrollments)
    .where(and(
      eq(enrollments.courseId, course.id),
      eq(enrollments.studentDid, did),
    )).limit(1);

  if (enrollResult.length === 0) {
    return errorResponse('Not enrolled in this course', 403);
  }

  const enrollment = enrollResult[0];

  // Verify lesson exists in this course
  const lessonResult = await db.select().from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(and(
      eq(lessons.id, lessonId),
      eq(modules.courseId, course.id),
    )).limit(1);

  if (lessonResult.length === 0) {
    return errorResponse('Lesson not found in this course', 404);
  }

  // Upsert progress
  const existingProgress = await db.select().from(lessonProgress)
    .where(and(
      eq(lessonProgress.enrollmentId, enrollment.id),
      eq(lessonProgress.lessonId, lessonId),
    )).limit(1);

  const now = new Date();

  if (existingProgress.length === 0) {
    await db.insert(lessonProgress).values({
      enrollmentId: enrollment.id,
      lessonId,
      status: 'completed',
      completedAt: now,
    });
  } else {
    await db.update(lessonProgress)
      .set({ status: 'completed', completedAt: now })
      .where(and(
        eq(lessonProgress.enrollmentId, enrollment.id),
        eq(lessonProgress.lessonId, lessonId),
      ));
  }

  // Check if all lessons are complete → mark course complete
  const totalLessons = await db.select({ count: sql<number>`count(*)` })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, course.id));

  const completedLessons = await db.select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(and(
      eq(lessonProgress.enrollmentId, enrollment.id),
      eq(lessonProgress.status, 'completed'),
    ));

  const total = Number(totalLessons[0]?.count || 0);
  const completed = Number(completedLessons[0]?.count || 0);

  if (completed >= total && total > 0 && !enrollment.completedAt) {
    await db.update(enrollments)
      .set({ completedAt: now })
      .where(eq(enrollments.id, enrollment.id));

    // Best-effort domain event via the kernel's public attestation API.
    emitLearnEvent({
      type: 'learn.completed',
      caller: auth,
      courseId: course.id,
      courseTitle: course.title,
      creatorDid: course.creatorDid,
      payload: { completed_at: now.toISOString(), modules_completed: total },
    }).catch(() => undefined);
  }

  return jsonResponse({
    lessonId,
    status: 'completed',
    completedAt: now,
    courseProgress: { total, completed, percentage: total > 0 ? Math.round((completed / total) * 100) : 0 },
  });
}
