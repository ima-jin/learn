import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, enrollments, lessonProgress } from '@/db';
import {
  STUDENT, makeRequest, params, seedCourse, seedEnrollment, seedLesson, seedModule, seedProgress, seedTree,
} from '@test/helpers';
import { AUTH_URL, installFakeKernel } from '@test/kernel';
import { POST } from '../route';

vi.mock('@/lib/signing-identity', async () => {
  // A throwaway key generated per run — no key material is committed.
  const { generatePrivateKey } = await import('@ima-jin/auth');
  const privateKey = generatePrivateKey();
  return { getSigningIdentity: () => ({ appDid: 'did:imajin:app', privateKey, publicKey: null }) };
});

const kernel = installFakeKernel();
const complete = (lessonId: string, opts: Parameters<typeof makeRequest>[2] = {}) =>
  POST(makeRequest('POST', `/api/courses/intro/lessons/${lessonId}/complete`, opts), params({ slug: 'intro', lessonId }));
const attestations = () => kernel.calls.filter((c) => c.url === `${AUTH_URL}/api/attestations`);

describe('POST /api/courses/[slug]/lessons/[lessonId]/complete', () => {
  it('requires authentication, a course, an enrollment and a lesson that belongs to the course', async () => {
    expect((await complete('lsn_1')).status).toBe(401);
    expect((await complete('lsn_1', { did: STUDENT })).status).toBe(404);

    await seedTree();
    const notEnrolled = await complete('lsn_1', { did: STUDENT });
    expect(notEnrolled.status).toBe(403);
    expect(await notEnrolled.json()).toEqual({ error: 'Not enrolled in this course' });

    await seedEnrollment();
    const missing = await complete('lsn_nope', { did: STUDENT });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Lesson not found in this course' });
  });

  it("rejects a lesson from a different course", async () => {
    await seedTree();
    await seedEnrollment();
    await seedCourse({ id: 'crs_2', slug: 'other' });
    await seedModule('crs_2', 'mod_x');
    await seedLesson('mod_x', 'lsn_foreign');
    expect((await complete('lsn_foreign', { did: STUDENT })).status).toBe(404);
  });

  it('marks the lesson complete and reports course progress without finishing the course', async () => {
    await seedTree();
    const enrollmentId = await seedEnrollment();
    await seedProgress(enrollmentId, 'lsn_1');
    await seedProgress(enrollmentId, 'lsn_2');

    const res = await complete('lsn_1', { did: STUDENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      lessonId: 'lsn_1',
      status: 'completed',
      courseProgress: { total: 2, completed: 1, percentage: 50 },
    });

    const [row] = await db.select().from(lessonProgress).where(eq(lessonProgress.lessonId, 'lsn_1'));
    expect(row.status).toBe('completed');
    expect(row.completedAt).toBeInstanceOf(Date);
    const [enrollment] = await db.select().from(enrollments);
    expect(enrollment.completedAt).toBeNull();
    await Promise.resolve();
    expect(attestations()).toHaveLength(0);
  });

  it('inserts a progress row when none was initialised (lesson added after enrolling)', async () => {
    await seedTree();
    await seedEnrollment();
    await complete('lsn_2', { did: STUDENT });
    const rows = await db.select().from(lessonProgress);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lessonId: 'lsn_2', status: 'completed' });
  });

  it('completes the course on the last lesson, once, and emits learn.completed', async () => {
    await seedTree();
    const enrollmentId = await seedEnrollment();
    await seedProgress(enrollmentId, 'lsn_1', 'completed');
    await seedProgress(enrollmentId, 'lsn_2');

    const res = await complete('lsn_2', { did: STUDENT });
    expect((await res.json()).courseProgress).toEqual({ total: 2, completed: 2, percentage: 100 });
    const [enrollment] = await db.select().from(enrollments);
    expect(enrollment.completedAt).toBeInstanceOf(Date);

    await vi.waitFor(() => expect(attestations()).toHaveLength(1));
    expect(attestations()[0].body).toMatchObject({
      type: 'learn.completed',
      subject_did: STUDENT,
      context_id: 'crs_1',
      payload: { delegator_did: STUDENT, modules_completed: 2, course_title: 'Intro' },
    });

    // re-completing a lesson of an already-completed course does not re-emit
    await complete('lsn_2', { did: STUDENT });
    await Promise.resolve();
    expect(attestations()).toHaveLength(1);
  });
});
