import { describe, expect, it } from 'vitest';
import { CREATOR, OTHER, STUDENT, makeRequest, seedCourse, seedEnrollment, seedTree } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { GET } from '../route';

installFakeKernel();
const get = (did?: string) => GET(makeRequest('GET', '/api/my/teaching', { did }));

describe('GET /api/my/teaching', () => {
  it('requires authentication', async () => {
    expect((await get()).status).toBe(401);
  });

  it("lists the caller's own courses (any status), newest first, with counts", async () => {
    await seedTree();
    await seedEnrollment('crs_1', STUDENT, 'enr_1');
    await seedEnrollment('crs_1', OTHER, 'enr_2');
    await seedCourse({ id: 'crs_draft', slug: 'draft', status: 'draft', createdAt: new Date('2030-01-01') });
    await seedCourse({ id: 'crs_not_mine', slug: 'not-mine', creatorDid: OTHER });

    const body = await (await get(CREATOR)).json();
    expect(body.courses.map((c: { id: string }) => c.id)).toEqual(['crs_draft', 'crs_1']);
    expect(body.courses[1]).toMatchObject({ enrollmentCount: 2, moduleCount: 1, lessonCount: 2 });
    expect(body.courses[0]).toMatchObject({ enrollmentCount: 0, moduleCount: 0, lessonCount: 0 });
  });

  it('is empty for someone who teaches nothing', async () => {
    await seedTree();
    expect(await (await get(STUDENT)).json()).toEqual({ courses: [] });
  });
});
