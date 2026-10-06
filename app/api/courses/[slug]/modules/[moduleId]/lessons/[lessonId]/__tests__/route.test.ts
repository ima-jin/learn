import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, lessons } from '@/db';
import { CREATOR, OTHER, STUDENT, makeRequest, params, seedCourse, seedEnrollment, seedLesson, seedModule, seedTree } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { DELETE, GET, PATCH } from '../route';

installFakeKernel();
const ctx = (moduleId = 'mod_1', lessonId = 'lsn_1') => params({ slug: 'intro', moduleId, lessonId });
const path = '/api/courses/intro/modules/mod_1/lessons/lsn_1';
const get = (did?: string, moduleId?: string, lessonId?: string) => GET(makeRequest('GET', path, { did }), ctx(moduleId, lessonId));
const patch = (did: string | undefined, body?: unknown, rawBody?: string, moduleId?: string, lessonId?: string) =>
  PATCH(makeRequest('PATCH', path, { did, body, rawBody }), ctx(moduleId, lessonId));
const del = (did?: string, moduleId?: string, lessonId?: string) => DELETE(makeRequest('DELETE', path, { did }), ctx(moduleId, lessonId));

describe('GET …/lessons/[lessonId]', () => {
  it('404s an unknown course or lesson', async () => {
    expect((await get()).status).toBe(404);
    await seedCourse();
    await seedModule();
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Lesson not found' });
  });

  it('returns a free course lesson, content included, to anyone', async () => {
    await seedTree();
    expect(await (await get()).json()).toMatchObject({ id: 'lsn_1', content: '# lsn_1 body', metadata: { secret: true } });
  });

  it('hides lessons of a private course from non-creators', async () => {
    await seedCourse({ visibility: 'private' });
    await seedModule();
    await seedLesson();
    expect((await get()).status).toBe(404);
    expect((await get(STUDENT)).status).toBe(404);
    expect((await get(CREATOR)).status).toBe(200);
  });

  it("does not serve a lesson through another course's URL (no paywall bypass)", async () => {
    await seedTree(); // free "intro" course
    await seedCourse({ id: 'crs_paid', slug: 'paid', price: 5000 });
    await seedModule('crs_paid', 'mod_paid');
    await seedLesson('mod_paid', 'lsn_paid');
    // the paid lesson id under the FREE course's slug, with both the free and the paid module id
    expect((await get(undefined, 'mod_1', 'lsn_paid')).status).toBe(404);
    expect((await get(undefined, 'mod_paid', 'lsn_paid')).status).toBe(404);
    // and a module that is not the lesson's own
    await seedModule('crs_1', 'mod_other', 5);
    expect((await get(undefined, 'mod_other', 'lsn_1')).status).toBe(404);
  });

  describe('paid course', () => {
    const setup = async () => {
      await seedCourse({ price: 900 });
      await seedModule();
      await seedLesson();
    };

    it('401s anonymous callers', async () => {
      await setup();
      const res = await get();
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Authentication required for paid courses' });
    });

    it('returns locked metadata (no content) to a non-enrolled user', async () => {
      await setup();
      const body = await (await get(OTHER)).json();
      expect(body).toEqual({
        id: 'lsn_1', title: 'Lesson lsn_1', contentType: 'markdown', durationMinutes: null, sortOrder: 0, content: null, locked: true,
      });
    });

    it('returns full content to the creator and to an enrolled student', async () => {
      await setup();
      await seedEnrollment();
      expect((await (await get(CREATOR)).json()).content).toBe('# lsn_1 body');
      expect((await (await get(STUDENT)).json()).content).toBe('# lsn_1 body');
    });
  });
});

describe('PATCH …/lessons/[lessonId]', () => {
  it('requires auth/course/ownership and a lesson in this module', async () => {
    expect((await patch(undefined, { title: 'x' })).status).toBe(401);
    expect((await patch(CREATOR, { title: 'x' })).status).toBe(404);
    await seedCourse();
    expect((await patch(OTHER, { title: 'x' })).status).toBe(403);
    expect((await patch(CREATOR, { title: 'x' })).status).toBe(404);
  });

  it("cannot edit another course's lesson", async () => {
    await seedCourse();
    await seedCourse({ id: 'crs_2', slug: 'other', creatorDid: OTHER });
    await seedModule('crs_2', 'mod_foreign');
    await seedLesson('mod_foreign', 'lsn_foreign');
    expect((await patch(CREATOR, { title: 'pwn' }, undefined, 'mod_foreign', 'lsn_foreign')).status).toBe(404);
    expect((await del(CREATOR, 'mod_foreign', 'lsn_foreign')).status).toBe(404);
    const [row] = await db.select().from(lessons).where(eq(lessons.id, 'lsn_foreign'));
    expect(row.title).toBe('Lesson lsn_foreign');
  });

  it('400s with nothing to update or malformed JSON', async () => {
    await seedTree();
    expect((await patch(CREATOR, { nope: 1 })).status).toBe(400);
    expect((await patch(CREATOR, undefined, '{bad')).status).toBe(400);
  });

  it('updates only allow-listed fields and stamps updatedAt', async () => {
    await seedTree();
    const res = await patch(CREATOR, {
      title: 'Renamed', contentType: 'video', content: 'new', durationMinutes: 7, sortOrder: 9, metadata: { b: 2 }, moduleId: 'mod_x', id: 'lsn_x',
    });
    expect(await res.json()).toMatchObject({
      id: 'lsn_1', moduleId: 'mod_1', title: 'Renamed', contentType: 'video', content: 'new', durationMinutes: 7, sortOrder: 9, metadata: { b: 2 },
    });
    const [row] = await db.select().from(lessons).where(eq(lessons.id, 'lsn_1'));
    expect(row.updatedAt).toBeInstanceOf(Date);
  });
});

describe('DELETE …/lessons/[lessonId]', () => {
  it('requires auth/course/ownership and the lesson', async () => {
    expect((await del()).status).toBe(401);
    expect((await del(CREATOR)).status).toBe(404);
    await seedCourse();
    expect((await del(OTHER)).status).toBe(403);
    expect((await del(CREATOR)).status).toBe(404);
  });

  it('deletes just that lesson', async () => {
    await seedTree();
    expect(await (await del(CREATOR)).json()).toEqual({ success: true });
    const left = await db.select().from(lessons);
    expect(left.map((l) => l.id)).toEqual(['lsn_2']);
  });
});
