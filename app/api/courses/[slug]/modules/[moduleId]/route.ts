import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { modules } from '@/db/schema';
import { getModuleInCourse } from '@/lib/course-access';
import { requireCourseOwner } from '@/lib/owner';
import { errorResponse, jsonResponse, readJson } from '@/lib/utils';

type RouteParams = { params: Promise<{ slug: string; moduleId: string }> };

/**
 * PATCH /api/courses/[slug]/modules/[moduleId] — Update module
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId } = await params;

  const owner = await requireCourseOwner(request, slug);
  if ('response' in owner) return owner.response;

  const mod = await getModuleInCourse(owner.course.id, moduleId);
  if (!mod) return errorResponse('Module not found', 404);

  const parsed = await readJson(request);
  if ('response' in parsed) return parsed.response;
  const { body } = parsed;

  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) updates.title = String(body.title).trim();
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;

  if (Object.keys(updates).length === 0) return errorResponse('No fields to update');

  await db.update(modules).set(updates).where(eq(modules.id, moduleId));

  const updated = await db.select().from(modules).where(eq(modules.id, moduleId)).limit(1);
  return jsonResponse(updated[0]);
}

/**
 * DELETE /api/courses/[slug]/modules/[moduleId] — Delete module (cascades lessons)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId } = await params;

  const owner = await requireCourseOwner(request, slug, { key: 'learn.module.delete', resourceId: moduleId });
  if ('response' in owner) return owner.response;

  const mod = await getModuleInCourse(owner.course.id, moduleId);
  if (!mod) return errorResponse('Module not found', 404);

  await db.delete(modules).where(eq(modules.id, moduleId));
  return jsonResponse({ success: true });
}
