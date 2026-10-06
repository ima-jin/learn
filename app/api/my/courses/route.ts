import { NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { courses, enrollments, lessonProgress } from '@/db/schema';
import { authenticate } from '@/lib/auth/authenticate';
import { errorResponse, jsonResponse } from '@/lib/utils';

/**
 * GET /api/my/courses — List courses I'm enrolled in
 */
export async function GET(request: NextRequest) {
  const authResult = await authenticate(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const did = authResult.auth.did;

  const myEnrollments = await db.select()
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(enrollments.studentDid, did));

  const result = await Promise.all(myEnrollments.map(async (row) => {
    const progress = await db.select({
      total: sql<number>`count(*)`,
      completed: sql<number>`count(*) filter (where status = 'completed')`,
    }).from(lessonProgress).where(eq(lessonProgress.enrollmentId, row.enrollments.id));

    const total = Number(progress[0]?.total || 0);
    const completed = Number(progress[0]?.completed || 0);

    return {
      ...row.courses,
      enrollment: {
        id: row.enrollments.id,
        enrolledAt: row.enrollments.enrolledAt,
        completedAt: row.enrollments.completedAt,
      },
      progress: {
        total,
        completed,
        percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
      },
    };
  }));

  return jsonResponse({ courses: result });
}
