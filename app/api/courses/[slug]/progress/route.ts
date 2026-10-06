import { NextRequest } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { enrollments, lessonProgress, lessons, modules } from '@/db/schema';
import { authenticate } from '@/lib/auth/authenticate';
import { getCourseBySlug } from '@/lib/course-access';
import { errorResponse, jsonResponse } from '@/lib/utils';

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * GET /api/courses/[slug]/progress — Get enrollment status + lesson progress
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const authResult = await authenticate(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const did = authResult.auth.did;

  const course = await getCourseBySlug(slug);
  if (!course) return errorResponse('Course not found', 404);

  const enrollResult = await db.select().from(enrollments)
    .where(and(
      eq(enrollments.courseId, course.id),
      eq(enrollments.studentDid, did),
    )).limit(1);

  if (enrollResult.length === 0) {
    return errorResponse('Not enrolled in this course', 403);
  }

  const enrollment = enrollResult[0];

  // Get all progress records
  const progress = await db.select().from(lessonProgress)
    .where(eq(lessonProgress.enrollmentId, enrollment.id));

  // Build module → lesson → progress map
  const courseModules = await db.select().from(modules)
    .where(eq(modules.courseId, course.id))
    .orderBy(asc(modules.sortOrder));

  const moduleProgress = await Promise.all(courseModules.map(async (mod) => {
    const moduleLessons = await db.select().from(lessons)
      .where(eq(lessons.moduleId, mod.id))
      .orderBy(asc(lessons.sortOrder));

    const lessonsWithProgress = moduleLessons.map(lesson => {
      const lp = progress.find(p => p.lessonId === lesson.id);
      return {
        id: lesson.id,
        title: lesson.title,
        contentType: lesson.contentType,
        durationMinutes: lesson.durationMinutes,
        status: lp?.status || 'not_started',
        completedAt: lp?.completedAt || null,
      };
    });

    const completed = lessonsWithProgress.filter(l => l.status === 'completed').length;

    return {
      id: mod.id,
      title: mod.title,
      lessons: lessonsWithProgress,
      completed,
      total: lessonsWithProgress.length,
    };
  }));

  const totalLessons = moduleProgress.reduce((sum, m) => sum + m.total, 0);
  const completedLessons = moduleProgress.reduce((sum, m) => sum + m.completed, 0);

  return jsonResponse({
    enrollment: {
      id: enrollment.id,
      enrolledAt: enrollment.enrolledAt,
      completedAt: enrollment.completedAt,
    },
    progress: {
      total: totalLessons,
      completed: completedLessons,
      percentage: totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0,
    },
    modules: moduleProgress,
  });
}
