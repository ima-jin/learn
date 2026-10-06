import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, enrollments, lessons } from '@/db';
import {
  CREATOR, OTHER, STUDENT, makeRequest, params, seedEnrollment, seedProgress, seedTree,
} from '@test/helpers';
import { PROFILE_URL, installFakeKernel } from '@test/kernel';
import { GET } from '../route';

const kernel = installFakeKernel();
const get = (did?: string) => GET(makeRequest('GET', '/api/courses/intro/students', { did }), params({ slug: 'intro' }));

describe('GET /api/courses/[slug]/students', () => {
  it('requires authentication, an existing course, and the creator', async () => {
    expect((await get()).status).toBe(401);
    expect((await get(CREATOR)).status).toBe(404);
    await seedTree();
    expect((await get(STUDENT)).status).toBe(403);
  });

  it('returns an empty roster without calling the profile service', async () => {
    await seedTree();
    const body = await (await get(CREATOR)).json();
    expect(body).toEqual({ courseTitle: 'Intro', totalStudents: 0, totalLessons: 2, students: [] });
    expect(kernel.calls.some((c) => c.url === `${PROFILE_URL}/api/resolve`)).toBe(false);
  });

  it('lists students oldest-first with progress and resolved profile names', async () => {
    await seedTree();
    const first = await seedEnrollment('crs_1', STUDENT, 'enr_1');
    await seedEnrollment('crs_1', OTHER, 'enr_2');
    await db.update(enrollments).set({ enrolledAt: new Date('2026-01-01') });
    await db.update(enrollments).set({ enrolledAt: new Date('2026-02-01') }).where(eq(enrollments.id, 'enr_2'));
    await seedProgress(first, 'lsn_1', 'completed');
    await seedProgress(first, 'lsn_2', 'completed');
    kernel.profiles.set(STUDENT, { did: STUDENT, handle: 'stu', displayName: 'Stu Dent' });

    const body = await (await get(CREATOR)).json();
    expect(body.totalStudents).toBe(2);
    expect(body.students[0]).toMatchObject({
      studentDid: STUDENT,
      handle: 'stu',
      displayName: 'Stu Dent',
      email: null,
      progress: { total: 2, completed: 2, percentage: 100 },
    });
    // an unresolvable profile falls back to nulls, keeping the DID
    expect(body.students[1]).toMatchObject({
      studentDid: OTHER, handle: null, displayName: null, email: null, progress: { total: 2, completed: 0, percentage: 0 },
    });
  });

  it('asks the profile service WITHOUT any credential — learn holds no service-scope secret', async () => {
    await seedTree();
    await seedEnrollment();
    await get(CREATOR);
    const call = kernel.calls.find((c) => c.url === `${PROFILE_URL}/api/resolve`);
    expect(call?.headers).not.toHaveProperty('authorization');
    expect(call?.body).toEqual({ dids: [STUDENT] });
  });

  it('degrades to DIDs only when the profile service is down', async () => {
    await seedTree();
    await seedEnrollment();
    kernel.respond.set('/api/resolve', () => new Response('down', { status: 503 }));
    const body = await (await get(CREATOR)).json();
    expect(body.students[0]).toMatchObject({ studentDid: STUDENT, displayName: null, handle: null });
  });

  it('reports 0% when the course has no lessons', async () => {
    await seedTree();
    await db.delete(lessons);
    await seedEnrollment();
    const body = await (await get(CREATOR)).json();
    expect(body.totalLessons).toBe(0);
    expect(body.students[0].progress.percentage).toBe(0);
  });
});
