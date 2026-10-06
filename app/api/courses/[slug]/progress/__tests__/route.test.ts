import { describe, expect, it } from 'vitest';
import { db, lessons } from '@/db';
import { OTHER, STUDENT, makeRequest, params, seedEnrollment, seedModule, seedLesson, seedProgress, seedTree } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { GET } from '../route';

installFakeKernel();
const get = (did?: string) => GET(makeRequest('GET', '/api/courses/intro/progress', { did }), params({ slug: 'intro' }));

describe('GET /api/courses/[slug]/progress', () => {
  it('requires authentication, a course, and an enrollment', async () => {
    expect((await get()).status).toBe(401);
    expect((await get(STUDENT)).status).toBe(404);
    await seedTree();
    const res = await get(OTHER);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not enrolled in this course' });
  });

  it('returns per-module, per-lesson progress with totals and a rounded percentage', async () => {
    await seedTree();
    await seedModule('crs_1', 'mod_2', 1);
    await seedLesson('mod_2', 'lsn_3', 0);
    const enrollmentId = await seedEnrollment();
    await seedProgress(enrollmentId, 'lsn_1', 'completed');
    await seedProgress(enrollmentId, 'lsn_2', 'in_progress');

    const res = await get(STUDENT);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrollment).toMatchObject({ id: enrollmentId });
    expect(body.progress).toEqual({ total: 3, completed: 1, percentage: 33 });
    expect(body.modules.map((m: { id: string }) => m.id)).toEqual(['mod_1', 'mod_2']);
    expect(body.modules[0]).toMatchObject({ completed: 1, total: 2 });
    expect(body.modules[0].lessons.map((l: { id: string; status: string }) => [l.id, l.status])).toEqual([
      ['lsn_1', 'completed'],
      ['lsn_2', 'in_progress'],
    ]);
    // lessons with no progress row default to not_started; bodies are never exposed here
    expect(body.modules[1].lessons[0]).toMatchObject({ id: 'lsn_3', status: 'not_started', completedAt: null });
    expect(body.modules[0].lessons[0]).not.toHaveProperty('content');
  });

  it('reports 0% when nothing is completed, and for a course with no lessons', async () => {
    await seedTree();
    await seedEnrollment();
    expect((await (await get(STUDENT)).json()).progress).toEqual({ total: 2, completed: 0, percentage: 0 });

    await db.delete(lessons);
    expect((await (await get(STUDENT)).json()).progress).toEqual({ total: 0, completed: 0, percentage: 0 });
  });
});
