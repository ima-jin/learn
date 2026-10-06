import { NextRequest } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { modules } from '@/db/schema';
import { requireCourseOwner } from '@/lib/owner';
import { errorResponse, jsonResponse, readJson } from '@/lib/utils';

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * PATCH /api/courses/[slug]/modules/reorder — Reorder modules
 * Body: { order: ["mod_abc", "mod_def", ...] }
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const owner = await requireCourseOwner(request, slug);
  if ('response' in owner) return owner.response;
  const { course } = owner;

  const parsed = await readJson(request);
  if ('response' in parsed) return parsed.response;
  const { order } = parsed.body;
  if (!Array.isArray(order)) return errorResponse('order must be an array of module IDs');

  // Update sort_order for each module — scoped to THIS course, so an owner can
  // never reorder (or probe) another course's modules by guessing IDs.
  await Promise.all(order.map((id: string, index: number) =>
    db.update(modules).set({ sortOrder: index }).where(and(eq(modules.id, id), eq(modules.courseId, course.id)))
  ));

  const updated = await db.select().from(modules)
    .where(eq(modules.courseId, course.id))
    .orderBy(asc(modules.sortOrder));

  return jsonResponse({ modules: updated });
}
