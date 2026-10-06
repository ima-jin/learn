import { describe, expect, it } from 'vitest';
import { db, modules } from '@/db';
import { CREATOR, OTHER, makeRequest, params, seedCourse, seedModule } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { GET, POST } from '../route';

installFakeKernel();
const ctx = params({ slug: 'intro' });
const post = (did: string | undefined, body?: unknown, rawBody?: string) =>
  POST(makeRequest('POST', '/api/courses/intro/modules', { did, body, rawBody }), ctx);
const get = (did?: string) => GET(makeRequest('GET', '/api/courses/intro/modules', { did }), ctx);

describe('POST /api/courses/[slug]/modules', () => {
  it('requires authentication, an existing course and ownership (in that order)', async () => {
    expect((await post(undefined, { title: 'M' })).status).toBe(401);
    expect((await post(CREATOR, { title: 'M' })).status).toBe(404);
    await seedCourse();
    expect((await post(OTHER, { title: 'M' })).status).toBe(403);
  });

  it('validates the body', async () => {
    await seedCourse();
    expect((await post(CREATOR, { title: '  ' })).status).toBe(400);
    expect((await post(CREATOR, { title: 42 })).status).toBe(400);
    expect((await post(CREATOR, undefined, '{bad')).status).toBe(400);
  });

  it('appends modules at the next sort order, trimming text', async () => {
    await seedCourse();
    const first = await post(CREATOR, { title: ' First ', description: ' desc ' });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ courseId: 'crs_1', title: 'First', description: 'desc', sortOrder: 0 });
    const second = await (await post(CREATOR, { title: 'Second' })).json();
    expect(second).toMatchObject({ sortOrder: 1, description: null });
    expect(second.id).toMatch(/^mod_/);
    expect((await db.select().from(modules))).toHaveLength(2);
  });

  it('honours an explicit sortOrder, including 0', async () => {
    await seedCourse();
    await post(CREATOR, { title: 'A' });
    expect((await (await post(CREATOR, { title: 'B', sortOrder: 0 })).json()).sortOrder).toBe(0);
  });
});

describe('GET /api/courses/[slug]/modules', () => {
  it('404s an unknown course', async () => {
    expect((await get()).status).toBe(404);
  });

  it('lists modules in sort order, publicly', async () => {
    await seedCourse();
    await seedModule('crs_1', 'mod_b', 1);
    await seedModule('crs_1', 'mod_a', 0);
    const body = await (await get()).json();
    expect(body.modules.map((m: { id: string }) => m.id)).toEqual(['mod_a', 'mod_b']);
  });

  it('hides a private course\'s modules from everyone but the creator', async () => {
    await seedCourse({ visibility: 'private' });
    await seedModule();
    expect((await get()).status).toBe(404);
    expect((await get(OTHER)).status).toBe(404);
    expect((await get(CREATOR)).status).toBe(200);
  });
});
