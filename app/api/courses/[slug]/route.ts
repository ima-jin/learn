import { NextRequest } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { courses, enrollments, lessonProgress, lessons, modules } from '@/db/schema';
import { authenticate, authenticateOptional } from '@/lib/auth/authenticate';
import { enforceOwnerMutationPolicy } from '@/lib/auth/delegation';
import { getCourseBySlug, withoutLessonContent } from '@/lib/course-access';
import { errorResponse, jsonResponse, readJson } from '@/lib/utils';

type RouteParams = { params: Promise<{ slug: string }> };

const UPDATABLE_FIELDS = ['title', 'description', 'slug', 'price', 'currency', 'visibility', 'imageUrl', 'imageAssetId', 'tags', 'metadata', 'status', 'eventSlug', 'courseType'];

/**
 * GET /api/courses/[slug] — Get course detail
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const course = await getCourseBySlug(slug);
  if (!course) {
    return errorResponse('Course not found', 404);
  }

  // Single session lookup for visibility, creator check, and enrollment
  const caller = await authenticateOptional(request);
  const isCreator = caller?.did === course.creatorDid;

  // Check visibility
  if (course.visibility === 'private' && !isCreator) {
    return errorResponse('Course not found', 404);
  }

  // see: trust-bound visibility check via connections service is not yet implemented

  // Get modules with lessons
  const courseModules = await db.select()
    .from(modules)
    .where(eq(modules.courseId, course.id))
    .orderBy(asc(modules.sortOrder));

  const modulesWithLessons = await Promise.all(courseModules.map(async (mod) => {
    const moduleLessons = await db.select({
      id: lessons.id,
      title: lessons.title,
      contentType: lessons.contentType,
      content: lessons.content,
      durationMinutes: lessons.durationMinutes,
      sortOrder: lessons.sortOrder,
      metadata: lessons.metadata,
    })
      .from(lessons)
      .where(eq(lessons.moduleId, mod.id))
      .orderBy(asc(lessons.sortOrder));

    // Strip content + metadata for non-creators (keep listing lean)
    const sanitized = isCreator
      ? moduleLessons
      : moduleLessons.map(withoutLessonContent);

    return { ...mod, lessons: sanitized };
  }));

  // Check enrollment for current user
  let enrollment = null;
  if (caller) {
    const enrollResult = await db.select()
      .from(enrollments)
      .where(and(
        eq(enrollments.courseId, course.id),
        eq(enrollments.studentDid, caller.did),
      ))
      .limit(1);

    if (enrollResult.length > 0) {
      // Get progress
      const progress = await db.select()
        .from(lessonProgress)
        .where(eq(lessonProgress.enrollmentId, enrollResult[0].id));

      const totalLessons = modulesWithLessons.reduce((sum, m) => sum + m.lessons.length, 0);
      const completedLessons = progress.filter(p => p.status === 'completed').length;

      enrollment = {
        ...enrollResult[0],
        progress: { total: totalLessons, completed: completedLessons },
      };
    }
  }

  return jsonResponse({
    ...course,
    modules: modulesWithLessons,
    enrollment,
    isCreator,
    isAuthenticated: !!caller,
  });
}

/**
 * PATCH /api/courses/[slug] — Update course (owner only)
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const course = await getCourseBySlug(slug);
  if (!course) {
    return errorResponse('Course not found', 404);
  }
  if (course.creatorDid !== authResult.auth.did) {
    return errorResponse('Not authorized', 403);
  }

  const parsed = await readJson(request);
  if ('response' in parsed) return parsed.response;
  const { body } = parsed;

  const updates: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse('No fields to update');
  }

  updates.updatedAt = new Date();

  await db.update(courses)
    .set(updates)
    .where(eq(courses.id, course.id));

  const updated = await db.select()
    .from(courses)
    .where(eq(courses.id, course.id))
    .limit(1);

  return jsonResponse(updated[0]);
}

/**
 * DELETE /api/courses/[slug] — Archive course (soft delete, owner only)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const delegationDenied = enforceOwnerMutationPolicy(authResult.auth, 'learn.course.delete', slug);
  if (delegationDenied) return delegationDenied;

  const course = await getCourseBySlug(slug);
  if (!course) {
    return errorResponse('Course not found', 404);
  }

  if (course.creatorDid !== authResult.auth.did) {
    return errorResponse('Not authorized', 403);
  }

  await db.update(courses)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(courses.id, course.id));

  return jsonResponse({ success: true });
}
