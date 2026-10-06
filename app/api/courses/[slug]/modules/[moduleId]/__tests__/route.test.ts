import { describe, expect, it } from 'vitest';
import { db, lessons, modules } from '@/db';
import { CREATOR, OTHER, makeRequest, params, seedCourse, seedLesson, seedModule } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { DELETE, PATCH } from '../route';

installFakeKernel();
const ctx = (moduleId = 'mod_1') => params({ slug: 'intro', moduleId });
const patch = (did: string | undefined, body?: unknown, moduleId?: string, rawBody?: string) =>
  PATCH(makeRequest('PATCH', '/api/courses/intro/modules/mod_1', { did, body, rawBody }), ctx(moduleId));
const del = (did?: string, moduleId?: string) =>
  DELETE(makeRequest('DELETE', '/api/courses/intro/modules/mod_1', { did }), ctx(moduleId));

describe('PATCH /api/courses/[slug]/modules/[moduleId]', () => {
  it('requires auth/course/ownership, and a module that belongs to the course', async () => {
    expect((await patch(undefined, { title: 'x' })).status).toBe(401);
    expect((await patch(CREATOR, { title: 'x' })).status).toBe(404);
    await seedCourse();
    expect((await patch(OTHER, { title: 'x' })).status).toBe(403);
    const missing = await patch(CREATOR, { title: 'x' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Module not found' });
  });

  it("cannot touch another course's module", async () => {
    await seedCourse();
    await seedCourse({ id: 'crs_2', slug: 'other', creatorDid: OTHER });
    await seedModule('crs_2', 'mod_foreign');
    expect((await patch(CREATOR, { title: 'pwn' }, 'mod_foreign')).status).toBe(404);
    expect((await del(CREATOR, 'mod_foreign')).status).toBe(404);
    const [row] = await db.select().from(modules);
    expect(row.title).toBe('Module mod_foreign');
  });

  it('400s with nothing to update or malformed JSON', async () => {
    await seedCourse();
    await seedModule();
    expect((await patch(CREATOR, {})).status).toBe(400);
    expect((await patch(CREATOR, undefined, 'mod_1', '{bad')).status).toBe(400);
  });

  it('updates title, description (empty clears it) and sortOrder', async () => {
    await seedCourse();
    await seedModule();
    const res = await patch(CREATOR, { title: ' New ', description: '  ', sortOrder: 5 });
    expect(await res.json()).toMatchObject({ id: 'mod_1', title: 'New', description: null, sortOrder: 5 });
    const again = await patch(CREATOR, { description: ' hello ' });
    expect((await again.json()).description).toBe('hello');
  });
});

describe('DELETE /api/courses/[slug]/modules/[moduleId]', () => {
  it('requires auth/course/ownership/module', async () => {
    expect((await del()).status).toBe(401);
    expect((await del(CREATOR)).status).toBe(404);
    await seedCourse();
    expect((await del(OTHER)).status).toBe(403);
    expect((await del(CREATOR)).status).toBe(404);
  });

  it('deletes the module and cascades to its lessons', async () => {
    await seedCourse();
    await seedModule();
    await seedLesson();
    const res = await del(CREATOR);
    expect(await res.json()).toEqual({ success: true });
    expect(await db.select().from(modules)).toHaveLength(0);
    expect(await db.select().from(lessons)).toHaveLength(0);
  });
});
