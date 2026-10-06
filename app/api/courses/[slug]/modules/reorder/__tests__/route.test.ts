import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, modules } from '@/db';
import { CREATOR, OTHER, makeRequest, params, seedCourse, seedModule } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { PATCH } from '../route';

installFakeKernel();
const patch = (did: string | undefined, body?: unknown, rawBody?: string) =>
  PATCH(makeRequest('PATCH', '/api/courses/intro/modules/reorder', { did, body, rawBody }), params({ slug: 'intro' }));

describe('PATCH /api/courses/[slug]/modules/reorder', () => {
  it('requires auth, an existing course and ownership', async () => {
    expect((await patch(undefined, { order: [] })).status).toBe(401);
    expect((await patch(CREATOR, { order: [] })).status).toBe(404);
    await seedCourse();
    expect((await patch(OTHER, { order: [] })).status).toBe(403);
  });

  it('requires `order` to be an array', async () => {
    await seedCourse();
    const res = await patch(CREATOR, { order: 'mod_1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'order must be an array of module IDs' });
    expect((await patch(CREATOR, undefined, '{bad')).status).toBe(400);
  });

  it('rewrites sort order to match the given order and returns the modules sorted', async () => {
    await seedCourse();
    await seedModule('crs_1', 'mod_a', 0);
    await seedModule('crs_1', 'mod_b', 1);
    await seedModule('crs_1', 'mod_c', 2);
    const body = await (await patch(CREATOR, { order: ['mod_c', 'mod_a', 'mod_b'] })).json();
    expect(body.modules.map((m: { id: string; sortOrder: number }) => [m.id, m.sortOrder])).toEqual([
      ['mod_c', 0], ['mod_a', 1], ['mod_b', 2],
    ]);
  });

  it("ignores ids from another course — an owner cannot reorder someone else's modules", async () => {
    await seedCourse();
    await seedModule('crs_1', 'mod_a', 0);
    await seedCourse({ id: 'crs_2', slug: 'other', creatorDid: OTHER });
    await seedModule('crs_2', 'mod_foreign', 7);
    const body = await (await patch(CREATOR, { order: ['mod_foreign', 'mod_a'] })).json();
    expect(body.modules.map((m: { id: string }) => m.id)).toEqual(['mod_a']);
    const [foreign] = await db.select().from(modules).where(eq(modules.id, 'mod_foreign'));
    expect(foreign.sortOrder).toBe(7);
  });
});
