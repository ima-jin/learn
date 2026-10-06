import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, lessons } from '@/db';
import { CREATOR, OTHER, makeRequest, params, seedCourse, seedLesson, seedModule, seedTree } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { PATCH } from '../route';

installFakeKernel();
const patch = (did: string | undefined, body?: unknown, rawBody?: string, moduleId = 'mod_1') =>
  PATCH(makeRequest('PATCH', '/api/courses/intro/modules/mod_1/lessons/reorder', { did, body, rawBody }), params({ slug: 'intro', moduleId }));

describe('PATCH …/lessons/reorder', () => {
  it('requires auth, course, ownership and a module in the course', async () => {
    expect((await patch(undefined, { order: [] })).status).toBe(401);
    expect((await patch(CREATOR, { order: [] })).status).toBe(404);
    await seedCourse();
    expect((await patch(OTHER, { order: [] })).status).toBe(403);
    const res = await patch(CREATOR, { order: [] });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Module not found' });
  });

  it('requires `order` to be an array', async () => {
    await seedTree();
    const res = await patch(CREATOR, { order: 'lsn_1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'order must be an array of lesson IDs' });
    expect((await patch(CREATOR, undefined, '{bad')).status).toBe(400);
  });

  it('rewrites sort order and returns the module\'s lessons sorted', async () => {
    await seedTree();
    const body = await (await patch(CREATOR, { order: ['lsn_2', 'lsn_1'] })).json();
    expect(body.lessons.map((l: { id: string; sortOrder: number }) => [l.id, l.sortOrder])).toEqual([['lsn_2', 0], ['lsn_1', 1]]);
  });

  it("ignores lesson ids that are not in this module — no reordering another course's lessons", async () => {
    await seedTree();
    await seedCourse({ id: 'crs_2', slug: 'other', creatorDid: OTHER });
    await seedModule('crs_2', 'mod_foreign');
    await seedLesson('mod_foreign', 'lsn_foreign', 4);
    const body = await (await patch(CREATOR, { order: ['lsn_foreign', 'lsn_1'] })).json();
    expect(body.lessons.map((l: { id: string }) => l.id).sort()).toEqual(['lsn_1', 'lsn_2']);
    const [foreign] = await db.select().from(lessons).where(eq(lessons.id, 'lsn_foreign'));
    expect(foreign.sortOrder).toBe(4);
  });
});
