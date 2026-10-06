import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { courses, db, lessons } from '@/db';
import {
  CREATOR, OTHER, STUDENT, makeRequest, params, seedCourse, seedEnrollment, seedProgress, seedTree,
} from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { DELETE, GET, PATCH } from '../route';

installFakeKernel();

const ctx = params({ slug: 'intro' });

describe('GET /api/courses/[slug]', () => {
  it('404s an unknown course', async () => {
    const res = await GET(makeRequest('GET', '/api/courses/intro'), ctx);
    expect(res.status).toBe(404);
  });

  it('shows an anonymous visitor the tree with lesson content and metadata stripped', async () => {
    await seedTree();
    const res = await GET(makeRequest('GET', '/api/courses/intro'), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ slug: 'intro', isCreator: false, isAuthenticated: false, enrollment: null });
    expect(body.modules).toHaveLength(1);
    expect(body.modules[0].lessons.map((l: { id: string }) => l.id)).toEqual(['lsn_1', 'lsn_2']);
    expect(body.modules[0].lessons[0]).not.toHaveProperty('content');
    expect(body.modules[0].lessons[0]).not.toHaveProperty('metadata');
  });

  it('gives the creator full lesson content', async () => {
    await seedTree();
    const body = await (await GET(makeRequest('GET', '/api/courses/intro', { did: CREATOR }), ctx)).json();
    expect(body.isCreator).toBe(true);
    expect(body.modules[0].lessons[0]).toMatchObject({ content: '# lsn_1 body', metadata: { secret: true } });
  });

  it('hides a private course from everyone but its creator', async () => {
    await seedCourse({ visibility: 'private' });
    expect((await GET(makeRequest('GET', '/api/courses/intro'), ctx)).status).toBe(404);
    expect((await GET(makeRequest('GET', '/api/courses/intro', { did: OTHER }), ctx)).status).toBe(404);
    expect((await GET(makeRequest('GET', '/api/courses/intro', { did: CREATOR }), ctx)).status).toBe(200);
  });

  it('treats an invalid credential as anonymous', async () => {
    await seedTree();
    const res = await GET(makeRequest('GET', '/api/courses/intro', { headers: { authorization: 'Bearer bogus' } }), ctx);
    expect((await res.json()).isAuthenticated).toBe(false);
  });

  it('reports the signed-in student\'s enrollment with progress counts', async () => {
    await seedTree();
    const enrollmentId = await seedEnrollment();
    await seedProgress(enrollmentId, 'lsn_1', 'completed');
    await seedProgress(enrollmentId, 'lsn_2', 'not_started');

    const body = await (await GET(makeRequest('GET', '/api/courses/intro', { did: STUDENT }), ctx)).json();
    expect(body.isAuthenticated).toBe(true);
    expect(body.enrollment).toMatchObject({ id: enrollmentId, studentDid: STUDENT, progress: { total: 2, completed: 1 } });
  });

  it('reports no enrollment for a signed-in non-student', async () => {
    await seedTree();
    const body = await (await GET(makeRequest('GET', '/api/courses/intro', { did: OTHER }), ctx)).json();
    expect(body).toMatchObject({ isAuthenticated: true, enrollment: null });
  });
});

describe('PATCH /api/courses/[slug]', () => {
  const patch = (did: string | undefined, body: unknown, rawBody?: string) =>
    PATCH(makeRequest('PATCH', '/api/courses/intro', { did, body, rawBody }), ctx);

  it('requires authentication', async () => {
    await seedCourse();
    expect((await patch(undefined, { title: 'x' })).status).toBe(401);
  });

  it('404s an unknown course, 403s a non-owner', async () => {
    expect((await patch(CREATOR, { title: 'x' })).status).toBe(404);
    await seedCourse();
    expect((await patch(OTHER, { title: 'x' })).status).toBe(403);
  });

  it('400s with nothing to update, and on malformed JSON', async () => {
    await seedCourse();
    const none = await patch(CREATOR, { unknownField: 1 });
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: 'No fields to update' });
    expect((await patch(CREATOR, undefined, '{bad')).status).toBe(400);
  });

  it('updates only allow-listed fields — including the camelCase ones that map to snake_case columns', async () => {
    await seedCourse();
    const res = await patch(CREATOR, {
      title: 'New title',
      imageUrl: 'https://img',
      imageAssetId: 'asset_1',
      eventSlug: 'ev',
      courseType: 'deck',
      status: 'published',
      creatorDid: 'did:imajin:attacker',
      id: 'crs_hacked',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: 'crs_1',
      creatorDid: CREATOR,
      title: 'New title',
      imageUrl: 'https://img',
      imageAssetId: 'asset_1',
      eventSlug: 'ev',
      courseType: 'deck',
    });
    const [row] = await db.select().from(courses).where(eq(courses.id, 'crs_1'));
    expect(row).toMatchObject({ imageUrl: 'https://img', eventSlug: 'ev', courseType: 'deck', creatorDid: CREATOR });
    expect(row.updatedAt).toBeInstanceOf(Date);
  });
});

describe('DELETE /api/courses/[slug]', () => {
  const del = (did?: string) => DELETE(makeRequest('DELETE', '/api/courses/intro', { did }), ctx);

  it('requires authentication, an existing course and ownership', async () => {
    expect((await del()).status).toBe(401);
    expect((await del(CREATOR)).status).toBe(404);
    await seedCourse();
    expect((await del(OTHER)).status).toBe(403);
  });

  it('archives (soft-deletes) the course', async () => {
    await seedTree();
    const res = await del(CREATOR);
    expect(await res.json()).toEqual({ success: true });
    const [row] = await db.select().from(courses).where(eq(courses.id, 'crs_1'));
    expect(row.status).toBe('archived');
    // archive, not delete: the course's children are untouched
    const kept = await db.select().from(lessons);
    expect(kept).toHaveLength(2);
  });
});
