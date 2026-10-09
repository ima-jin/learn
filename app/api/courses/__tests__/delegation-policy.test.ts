import { describe, expect, it, vi } from 'vitest';
import { courses, db, lessons, modules } from '@/db';
import { CREATOR, OTHER, makeRequest, params, seedCourse, seedLesson, seedModule } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { DELETE as deleteCourse } from '../[slug]/route';
import { DELETE as deleteModule } from '../[slug]/modules/[moduleId]/route';
import { DELETE as deleteLesson } from '../[slug]/modules/[moduleId]/lessons/[lessonId]/route';

/**
 * The published `requireSessionOrAppToken` does not yet surface `X-Acting-For`
 * (agent delegation), so these tests inject `actingFor` on top of the REAL
 * authenticate() result to drive the route-level policy.
 */
const delegation = vi.hoisted(() => ({ actingFor: undefined as string | undefined }));

vi.mock('@/lib/auth/authenticate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/authenticate')>();
  return {
    ...actual,
    authenticate: async (request: Request, options?: Parameters<typeof actual.authenticate>[1]) => {
      const result = await actual.authenticate(request, options);
      if ('error' in result || !delegation.actingFor) return result;
      return { auth: { ...result.auth, actingFor: delegation.actingFor } };
    },
  };
});

installFakeKernel();

const AGENT = 'did:imajin:agent';

const callCourse = (did?: string) => deleteCourse(makeRequest('DELETE', '/api/courses/intro', { did }), params({ slug: 'intro' }));
const callModule = (did?: string) =>
  deleteModule(
    makeRequest('DELETE', '/api/courses/intro/modules/mod_1', { did }),
    params({ slug: 'intro', moduleId: 'mod_1' }),
  );
const callLesson = (did?: string) =>
  deleteLesson(
    makeRequest('DELETE', '/api/courses/intro/modules/mod_1/lessons/lsn_1', { did }),
    params({ slug: 'intro', moduleId: 'mod_1', lessonId: 'lsn_1' }),
  );

async function seedAll() {
  await seedCourse();
  await seedModule();
  await seedLesson();
}

function actAs(actingFor: string | undefined) {
  delegation.actingFor = actingFor;
}

describe.each([
  { name: 'course', call: callCourse, key: 'learn.course.delete', resourceId: 'intro' },
  { name: 'module', call: callModule, key: 'learn.module.delete', resourceId: 'mod_1' },
  { name: 'lesson', call: callLesson, key: 'learn.lesson.delete', resourceId: 'lsn_1' },
])('delegation policy on $name delete', ({ call, key, resourceId }) => {
  it('blocks an agent delegate with 403 AGENT_APPROVAL_REQUIRED and mutates nothing', async () => {
    await seedAll();
    actAs(CREATOR);
    const res = await call(AGENT);
    actAs(undefined);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'AGENT_APPROVAL_REQUIRED',
      action: 'delete',
      class: 'irreversible',
      resourceId,
      ownerDid: CREATOR,
      delegateDid: AGENT,
    });
    const [course] = await db.select().from(courses);
    expect(course.status).toBe('published');
    expect(await db.select().from(modules)).toHaveLength(1);
    expect(await db.select().from(lessons)).toHaveLength(1);
    expect(key).toMatch(/^learn\./);
  });

  it('denies the delegate before the course lookup (no existence/ownership leak)', async () => {
    actAs(CREATOR);
    const res = await call(AGENT);
    actAs(undefined);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('AGENT_APPROVAL_REQUIRED');
  });

  it('still 401s an unauthenticated caller before the policy runs', async () => {
    actAs(CREATOR);
    const res = await call();
    actAs(undefined);
    expect(res.status).toBe(401);
  });

  it('lets the owner acting as themselves through (self-delegation)', async () => {
    await seedAll();
    actAs(CREATOR);
    const res = await call(CREATOR);
    actAs(undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('keeps the plain ownership 403 for a non-delegated non-owner', async () => {
    await seedAll();
    const res = await call(OTHER);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not authorized' });
  });
});
