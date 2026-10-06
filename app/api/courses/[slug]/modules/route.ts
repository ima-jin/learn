import { NextRequest } from 'next/server';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { modules } from '@/db/schema';
import { authenticateOptional } from '@/lib/auth/authenticate';
import { getCourseBySlug, resolveContentAccess } from '@/lib/course-access';
import { requireCourseOwner } from '@/lib/owner';
import { errorResponse, generateId, jsonResponse, readJson } from '@/lib/utils';

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * POST /api/courses/[slug]/modules — Add module
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const owner = await requireCourseOwner(request, slug);
  if ('response' in owner) return owner.response;
  const { course } = owner;

  const parsed = await readJson(request);
  if ('response' in parsed) return parsed.response;
  const { body } = parsed;
  if (typeof body.title !== 'string' || !body.title.trim()) return errorResponse('Title is required');

  // Get next sort order
  const maxOrder = await db.select({ max: sql<number>`coalesce(max(sort_order), -1)` })
    .from(modules).where(eq(modules.courseId, course.id));

  const mod = {
    id: generateId('mod'),
    courseId: course.id,
    title: body.title.trim(),
    description: body.description?.trim() || null,
    sortOrder: body.sortOrder ?? (Number(maxOrder[0]?.max ?? -1) + 1),
  };

  await db.insert(modules).values(mod);
  return jsonResponse(mod, 201);
}

/**
 * GET /api/courses/[slug]/modules — List modules
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const course = await getCourseBySlug(slug);
  if (!course) return errorResponse('Course not found', 404);

  // Private courses are invisible to everyone but their creator.
  const caller = await authenticateOptional(request);
  if ((await resolveContentAccess(course, caller?.did ?? null)) === 'hidden') {
    return errorResponse('Course not found', 404);
  }

  const result = await db.select()
    .from(modules)
    .where(eq(modules.courseId, course.id))
    .orderBy(asc(modules.sortOrder));

  return jsonResponse({ modules: result });
}
