import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { lessons } from '@/db/schema';
import { authenticateOptional } from '@/lib/auth/authenticate';
import { getCourseBySlug, getLessonInCourse, resolveContentAccess } from '@/lib/course-access';
import { requireCourseOwner } from '@/lib/owner';
import { errorResponse, jsonResponse, readJson } from '@/lib/utils';

type RouteParams = { params: Promise<{ slug: string; moduleId: string; lessonId: string }> };

const UPDATABLE_FIELDS = ['title', 'contentType', 'content', 'durationMinutes', 'sortOrder', 'metadata'];

/**
 * GET /api/courses/[slug]/modules/[moduleId]/lessons/[lessonId] — Get lesson content
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId, lessonId } = await params;

  const course = await getCourseBySlug(slug);
  if (!course) return errorResponse('Course not found', 404);

  const caller = await authenticateOptional(request);
  const access = await resolveContentAccess(course, caller?.did ?? null);
  if (access === 'hidden') return errorResponse('Course not found', 404);

  // The lesson must belong to THIS course's module — otherwise a free course's
  // URL could be used to read a paid course's lesson content.
  const lesson = await getLessonInCourse(course.id, moduleId, lessonId);
  if (!lesson) return errorResponse('Lesson not found', 404);

  if (access === 'locked') {
    if (!caller) return errorResponse('Authentication required for paid courses', 401);

    // Return lesson metadata but not content
    return jsonResponse({
      id: lesson.id,
      title: lesson.title,
      contentType: lesson.contentType,
      durationMinutes: lesson.durationMinutes,
      sortOrder: lesson.sortOrder,
      content: null,
      locked: true,
    });
  }

  return jsonResponse(lesson);
}

/**
 * PATCH /api/courses/[slug]/modules/[moduleId]/lessons/[lessonId] — Update lesson
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId, lessonId } = await params;

  const owner = await requireCourseOwner(request, slug);
  if ('response' in owner) return owner.response;

  const lesson = await getLessonInCourse(owner.course.id, moduleId, lessonId);
  if (!lesson) return errorResponse('Lesson not found', 404);

  const parsed = await readJson(request);
  if ('response' in parsed) return parsed.response;
  const { body } = parsed;

  const updates: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (body[field] !== undefined) updates[field] = body[field];
  }

  if (Object.keys(updates).length === 0) return errorResponse('No fields to update');
  updates.updatedAt = new Date();

  await db.update(lessons).set(updates).where(eq(lessons.id, lessonId));

  const updated = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  return jsonResponse(updated[0]);
}

/**
 * DELETE /api/courses/[slug]/modules/[moduleId]/lessons/[lessonId] — Delete lesson
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId, lessonId } = await params;

  const owner = await requireCourseOwner(request, slug, { key: 'learn.lesson.delete', resourceId: lessonId });
  if ('response' in owner) return owner.response;

  const lesson = await getLessonInCourse(owner.course.id, moduleId, lessonId);
  if (!lesson) return errorResponse('Lesson not found', 404);

  await db.delete(lessons).where(eq(lessons.id, lessonId));
  return jsonResponse({ success: true });
}
