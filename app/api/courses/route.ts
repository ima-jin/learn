import { NextRequest } from 'next/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getNodeSelf } from '@ima-jin/config';
import { buildFairManifest } from '@ima-jin/fair';
import { db } from '@/db';
import { courses, lessons, modules } from '@/db/schema';
import { authenticate } from '@/lib/auth/authenticate';
import { errorResponse, generateId, intParam, jsonResponse, readJson, slugify } from '@/lib/utils';

/**
 * POST /api/courses — Create a new course
 */
export async function POST(request: NextRequest) {
  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { did } = authResult.auth;
  const parsed = await readJson(request);
  if ('response' in parsed) return parsed.response;
  const { title, description, slug, price, currency, visibility, imageUrl, imageAssetId, tags, metadata } = parsed.body;

  if (typeof title !== 'string' || !title.trim()) {
    return errorResponse('Title is required');
  }

  const courseSlug = slug?.trim() || slugify(title);

  // Check slug uniqueness
  const existing = await db.select({ id: courses.id })
    .from(courses)
    .where(eq(courses.slug, courseSlug))
    .limit(1);

  if (existing.length > 0) {
    return errorResponse('A course with this slug already exists', 409);
  }

  // Node fee config comes from the registry's public node/self route (#2000).
  // Scope (group) fees need acting-as, which the app-token contract does not
  // carry — creators always act as themselves, so scopeDid is null.
  const nodeSelf = await getNodeSelf();
  const courseId = generateId('crs');
  const fairManifest = buildFairManifest({
    creatorDid: did,
    contentDid: courseId,
    contentType: 'course',
    scopeDid: null,
    scopeFeeBps: null,
    nodeFeeBps: nodeSelf?.nodeFeeBps ?? undefined,
    buyerCreditBps: nodeSelf?.buyerCreditBps ?? undefined,
    nodeOperatorDid: nodeSelf?.nodeOperatorDid ?? undefined,
  });

  const course = {
    id: courseId,
    creatorDid: did,
    title: title.trim(),
    description: description?.trim() || null,
    slug: courseSlug,
    price: price ?? 0,
    currency: currency || 'CAD',
    visibility: visibility || 'public',
    imageUrl: imageUrl || null,
    imageAssetId: imageAssetId || null,
    tags: tags || [],
    metadata: { ...metadata, fair: fairManifest },
    status: 'draft' as const,
  };

  await db.insert(courses).values(course);

  return jsonResponse(course, 201);
}

/**
 * GET /api/courses — List published courses (discovery)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const creatorDid = searchParams.get('creator_did');
  const status = searchParams.get('status') || 'published';
  const limit = intParam(searchParams.get('limit'), 20, 1, 100);
  const offset = intParam(searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  const conditions = [];

  // Public discovery only shows published courses by default
  conditions.push(eq(courses.status, status));

  if (creatorDid) {
    conditions.push(eq(courses.creatorDid, creatorDid));
  }

  // Visibility filter — only show public courses in discovery
  // Trust-bound courses need connection check (handled in detail endpoint)
  if (!creatorDid) {
    conditions.push(eq(courses.visibility, 'public'));
  }

  const results = await db.select()
    .from(courses)
    .where(and(...conditions))
    .orderBy(desc(courses.createdAt))
    .limit(limit)
    .offset(offset);

  // Add module + lesson counts
  const enriched = await Promise.all(results.map(async (course) => {
    const moduleCounts = await db.select({
      count: sql<number>`count(*)`,
    }).from(modules).where(eq(modules.courseId, course.id));

    const lessonCounts = await db.select({
      count: sql<number>`count(*)`,
    }).from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(eq(modules.courseId, course.id));

    return {
      ...course,
      moduleCount: Number(moduleCounts[0]?.count || 0),
      lessonCount: Number(lessonCounts[0]?.count || 0),
    };
  }));

  return jsonResponse({ courses: enriched, limit, offset });
}
