import { NextRequest } from 'next/server';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { lessons } from '@/db/schema';
import { authenticateOptional } from '@/lib/auth/authenticate';
import { getCourseBySlug, getModuleInCourse, resolveContentAccess } from '@/lib/course-access';
import { requireCourseOwner } from '@/lib/owner';
import { errorResponse, generateId, jsonResponse, readJson } from '@/lib/utils';

type RouteParams = { params: Promise<{ slug: string; moduleId: string }> };

/**
 * POST /api/courses/[slug]/modules/[moduleId]/lessons — Add lesson
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId } = await params;

  const owner = await requireCourseOwner(request, slug);
  if ('response' in owner) return owner.response;

  const mod = await getModuleInCourse(owner.course.id, moduleId);
  if (!mod) return errorResponse('Module not found', 404);

  const parsed = await readJson(request);
  if ('response' in parsed) return parsed.response;
  const { body } = parsed;
  if (typeof body.title !== 'string' || !body.title.trim()) return errorResponse('Title is required');

  const maxOrder = await db.select({ max: sql<number>`coalesce(max(sort_order), -1)` })
    .from(lessons).where(eq(lessons.moduleId, moduleId));

  const lesson = {
    id: generateId('lsn'),
    moduleId,
    title: body.title.trim(),
    contentType: body.contentType || 'markdown',
    content: body.content || null,
    durationMinutes: body.durationMinutes || null,
    sortOrder: body.sortOrder ?? (Number(maxOrder[0]?.max ?? -1) + 1),
    metadata: body.metadata || {},
  };

  await db.insert(lessons).values(lesson);
  return jsonResponse(lesson, 201);
}

/**
 * GET /api/courses/[slug]/modules/[moduleId]/lessons — List lessons in module
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId } = await params;

  const course = await getCourseBySlug(slug);
  if (!course) return errorResponse('Course not found', 404);

  const caller = await authenticateOptional(request);
  const access = await resolveContentAccess(course, caller?.did ?? null);
  if (access === 'hidden') return errorResponse('Course not found', 404);

  const mod = await getModuleInCourse(course.id, moduleId);
  if (!mod) return errorResponse('Module not found', 404);

  const result = await db.select()
    .from(lessons)
    .where(eq(lessons.moduleId, moduleId))
    .orderBy(asc(lessons.sortOrder));

  // Paid-course content stays locked for anyone who is not the creator or enrolled.
  if (access === 'locked') {
    return jsonResponse({
      lessons: result.map(({ content: _content, metadata: _metadata, ...rest }) => ({ ...rest, content: null, locked: true })),
    });
  }

  return jsonResponse({ lessons: result });
}
