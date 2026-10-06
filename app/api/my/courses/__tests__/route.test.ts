import { describe, expect, it } from 'vitest';
import { OTHER, STUDENT, makeRequest, seedCourse, seedEnrollment, seedLesson, seedModule, seedProgress, seedTree } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { GET } from '../route';

installFakeKernel();
const get = (did?: string) => GET(makeRequest('GET', '/api/my/courses', { did }));

describe('GET /api/my/courses', () => {
  it('requires authentication', async () => {
    expect((await get()).status).toBe(401);
  });

  it('is empty for a caller with no enrollments', async () => {
    await seedTree();
    expect(await (await get(STUDENT)).json()).toEqual({ courses: [] });
  });

  it("lists the caller's enrolled courses with enrollment info and progress — and nobody else's", async () => {
    await seedTree();
    const enrollmentId = await seedEnrollment();
    await seedProgress(enrollmentId, 'lsn_1', 'completed');
    await seedProgress(enrollmentId, 'lsn_2');
    // another course the caller is not in, and another student in this course
    await seedCourse({ id: 'crs_2', slug: 'other' });
    await seedModule('crs_2', 'mod_2');
    await seedLesson('mod_2', 'lsn_x');
    await seedEnrollment('crs_1', OTHER, 'enr_other');

    const body = await (await get(STUDENT)).json();
    expect(body.courses).toHaveLength(1);
    expect(body.courses[0]).toMatchObject({
      id: 'crs_1',
      slug: 'intro',
      enrollment: { id: enrollmentId, completedAt: null },
      progress: { total: 2, completed: 1, percentage: 50 },
    });
  });

  it('reports 0% for an enrollment with no progress rows', async () => {
    await seedCourse();
    await seedEnrollment();
    const body = await (await get(STUDENT)).json();
    expect(body.courses[0].progress).toEqual({ total: 0, completed: 0, percentage: 0 });
  });
});
