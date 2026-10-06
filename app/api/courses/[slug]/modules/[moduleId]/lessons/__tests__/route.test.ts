import { describe, expect, it } from 'vitest';
import { db, lessons } from '@/db';
import { CREATOR, OTHER, STUDENT, makeRequest, params, seedCourse, seedEnrollment, seedLesson, seedModule, seedTree } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { GET, POST } from '../route';

installFakeKernel();
const ctx = (moduleId = 'mod_1') => params({ slug: 'intro', moduleId });
const post = (did: string | undefined, body?: unknown, moduleId?: string, rawBody?: string) =>
  POST(makeRequest('POST', '/api/courses/intro/modules/mod_1/lessons', { did, body, rawBody }), ctx(moduleId));
const get = (did?: string, moduleId?: string) =>
  GET(makeRequest('GET', '/api/courses/intro/modules/mod_1/lessons', { did }), ctx(moduleId));

describe('POST …/modules/[moduleId]/lessons', () => {
  it('requires auth/course/ownership, and a module in the course', async () => {
    expect((await post(undefined, { title: 'L' })).status).toBe(401);
    expect((await post(CREATOR, { title: 'L' })).status).toBe(404);
    await seedCourse();
    expect((await post(OTHER, { title: 'L' })).status).toBe(403);
    const noModule = await post(CREATOR, { title: 'L' });
    expect(noModule.status).toBe(404);
    expect(await noModule.json()).toEqual({ error: 'Module not found' });
  });

  it("cannot add a lesson to another course's module", async () => {
    await seedCourse();
    await seedCourse({ id: 'crs_2', slug: 'other', creatorDid: OTHER });
    await seedModule('crs_2', 'mod_foreign');
    expect((await post(CREATOR, { title: 'L' }, 'mod_foreign')).status).toBe(404);
    expect(await db.select().from(lessons)).toHaveLength(0);
  });

  it('validates the body', async () => {
    await seedCourse();
    await seedModule();
    expect((await post(CREATOR, { title: ' ' })).status).toBe(400);
    expect((await post(CREATOR, undefined, 'mod_1', '{bad')).status).toBe(400);
  });

  it('creates lessons with defaults and appends at the next sort order', async () => {
    await seedCourse();
    await seedModule();
    const first = await post(CREATOR, { title: ' One ' });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      moduleId: 'mod_1', title: 'One', contentType: 'markdown', content: null, durationMinutes: null, sortOrder: 0, metadata: {},
    });
    const second = await (await post(CREATOR, {
      title: 'Two', contentType: 'video', content: 'https://v', durationMinutes: 12, metadata: { a: 1 },
    })).json();
    expect(second).toMatchObject({ contentType: 'video', content: 'https://v', durationMinutes: 12, sortOrder: 1, metadata: { a: 1 } });
    expect(second.id).toMatch(/^lsn_/);
  });

  it('honours an explicit sortOrder, including 0', async () => {
    await seedCourse();
    await seedModule();
    await post(CREATOR, { title: 'A' });
    expect((await (await post(CREATOR, { title: 'B', sortOrder: 0 })).json()).sortOrder).toBe(0);
  });
});

describe('GET …/modules/[moduleId]/lessons', () => {
  it('404s an unknown course or a module outside the course', async () => {
    expect((await get()).status).toBe(404);
    await seedTree();
    await seedCourse({ id: 'crs_2', slug: 'other' });
    await seedModule('crs_2', 'mod_foreign');
    expect((await get(undefined, 'mod_foreign')).status).toBe(404);
  });

  it('lists a free course\'s lessons, in order, with content', async () => {
    await seedTree();
    const body = await (await get()).json();
    expect(body.lessons.map((l: { id: string }) => l.id)).toEqual(['lsn_1', 'lsn_2']);
    expect(body.lessons[0].content).toBe('# lsn_1 body');
  });

  it('hides a private course from everyone but the creator', async () => {
    await seedCourse({ visibility: 'private' });
    await seedModule();
    expect((await get()).status).toBe(404);
    expect((await get(OTHER)).status).toBe(404);
    expect((await get(CREATOR)).status).toBe(200);
  });

  describe('paid course', () => {
    const setup = async () => {
      await seedCourse({ price: 900 });
      await seedModule();
      await seedLesson();
    };

    it('locks content for anonymous callers and non-students', async () => {
      await setup();
      for (const did of [undefined, OTHER]) {
        const body = await (await get(did)).json();
        expect(body.lessons[0]).toMatchObject({ id: 'lsn_1', title: 'Lesson lsn_1', content: null, locked: true });
        expect(body.lessons[0]).not.toHaveProperty('metadata');
      }
    });

    it('serves full content to the creator and to enrolled students', async () => {
      await setup();
      await seedEnrollment();
      for (const did of [CREATOR, STUDENT]) {
        const body = await (await get(did)).json();
        expect(body.lessons[0]).toMatchObject({ content: '# lsn_1 body', metadata: { secret: true } });
        expect(body.lessons[0]).not.toHaveProperty('locked');
      }
    });
  });
});
