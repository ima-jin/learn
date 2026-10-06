import { NextRequest } from 'next/server';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { courses, enrollments, lessons, modules } from '@/db/schema';
import { authenticate } from '@/lib/auth/authenticate';
import { errorResponse, jsonResponse } from '@/lib/utils';

/**
 * GET /api/my/teaching — List courses I created
 */
export async function GET(request: NextRequest) {
  const authResult = await authenticate(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const did = authResult.auth.did;

  const myCourses = await db.select()
    .from(courses)
    .where(eq(courses.creatorDid, did))
    .orderBy(desc(courses.createdAt));

  const result = await Promise.all(myCourses.map(async (course) => {
    const enrollCount = await db.select({ count: sql<number>`count(*)` })
      .from(enrollments).where(eq(enrollments.courseId, course.id));

    const moduleCount = await db.select({ count: sql<number>`count(*)` })
      .from(modules).where(eq(modules.courseId, course.id));

    const lessonCount = await db.select({ count: sql<number>`count(*)` })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(eq(modules.courseId, course.id));

    return {
      ...course,
      enrollmentCount: Number(enrollCount[0]?.count || 0),
      moduleCount: Number(moduleCount[0]?.count || 0),
      lessonCount: Number(lessonCount[0]?.count || 0),
    };
  }));

  return jsonResponse({ courses: result });
}
