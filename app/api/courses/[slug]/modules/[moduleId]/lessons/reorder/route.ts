import { NextRequest } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { lessons } from '@/db/schema';
import { getModuleInCourse } from '@/lib/course-access';
import { requireCourseOwner } from '@/lib/owner';
import { errorResponse, jsonResponse, readJson } from '@/lib/utils';

type RouteParams = { params: Promise<{ slug: string; moduleId: string }> };

/**
 * PATCH /api/courses/[slug]/modules/[moduleId]/lessons/reorder — Reorder lessons
 * Body: { order: ["lsn_abc", "lsn_def", ...] }
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId } = await params;

  const owner = await requireCourseOwner(request, slug);
  if ('response' in owner) return owner.response;

  const mod = await getModuleInCourse(owner.course.id, moduleId);
  if (!mod) return errorResponse('Module not found', 404);

  const parsed = await readJson(request);
  if ('response' in parsed) return parsed.response;
  const { order } = parsed.body;
  if (!Array.isArray(order)) return errorResponse('order must be an array of lesson IDs');

  // Scoped to THIS module, so an owner can never reorder another course's lessons.
  await Promise.all(order.map((id: string, index: number) =>
    db.update(lessons).set({ sortOrder: index }).where(and(eq(lessons.id, id), eq(lessons.moduleId, moduleId)))
  ));

  const updated = await db.select().from(lessons)
    .where(eq(lessons.moduleId, moduleId))
    .orderBy(asc(lessons.sortOrder));

  return jsonResponse({ lessons: updated });
}
