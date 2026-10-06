import { NextRequest } from 'next/server';
import { and, asc, count, eq } from 'drizzle-orm';
import { resolveIdentitiesForDids } from '@ima-jin/auth';
import { db } from '@/db';
import { enrollments, lessonProgress, lessons, modules } from '@/db/schema';
import { authenticate } from '@/lib/auth/authenticate';
import { getCourseBySlug } from '@/lib/course-access';
import { errorResponse, jsonResponse } from '@/lib/utils';

type RouteParams = { params: Promise<{ slug: string }> };

type ProfileSummary = { did: string; handle: string | null; displayName: string | null; email?: string };

/**
 * GET /api/courses/[slug]/students — List enrolled students with progress (creator only)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const course = await getCourseBySlug(slug);
  if (!course) return errorResponse('Course not found', 404);
  if (course.creatorDid !== authResult.auth.did) return errorResponse('Not authorized', 403);

  // Count total lessons
  const courseModules = await db.select({ id: modules.id })
    .from(modules)
    .where(eq(modules.courseId, course.id));

  let totalLessons = 0;
  for (const mod of courseModules) {
    const [result] = await db.select({ count: count() })
      .from(lessons)
      .where(eq(lessons.moduleId, mod.id));
    totalLessons += result.count;
  }

  // Get enrollments with progress
  const enrolled = await db.select()
    .from(enrollments)
    .where(eq(enrollments.courseId, course.id))
    .orderBy(asc(enrollments.enrolledAt));

  // Resolve DIDs to handle/display name via the kernel profile service's
  // batched /api/resolve route (#1998). This app holds no service-scope
  // credential, so the kernel returns only what its public view allows
  // (never another user's email). Fails soft (empty map) on an unreachable or
  // misconfigured profile service, continuing with DIDs only.
  const studentDids = enrolled.map(e => e.studentDid);
  const profileMap: Map<string, ProfileSummary> = studentDids.length > 0
    ? await resolveIdentitiesForDids(studentDids)
    : new Map();

  const students = await Promise.all(enrolled.map(async (enrollment) => {
    // Count completed lessons
    const [progress] = await db.select({ completed: count() })
      .from(lessonProgress)
      .where(
        and(
          eq(lessonProgress.enrollmentId, enrollment.id),
          eq(lessonProgress.status, 'completed')
        )
      );

    const profile = profileMap.get(enrollment.studentDid);

    return {
      studentDid: enrollment.studentDid,
      displayName: profile?.displayName || null,
      email: profile?.email || null,
      handle: profile?.handle || null,
      enrolledAt: enrollment.enrolledAt,
      completedAt: enrollment.completedAt,
      progress: {
        total: totalLessons,
        completed: progress.completed,
        percentage: totalLessons > 0 ? Math.round((progress.completed / totalLessons) * 100) : 0,
      },
    };
  }));

  return jsonResponse({
    courseTitle: course.title,
    totalStudents: students.length,
    totalLessons,
    students,
  });
}
