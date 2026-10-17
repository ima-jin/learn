import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { evaluateDelegationPolicy } from '@ima-jin/auth/delegation-policy';
import { courses, db, enrollments, lessonProgress, lessons, modules } from '@/db';
import { authenticate, authenticateOptional } from '@/lib/auth/authenticate';
import { LEARN_DELEGATION_ROUTES } from '@/lib/auth/delegation';
import { CREATOR, OTHER, makeRequest, params, seedCourse, seedEnrollment, seedLesson, seedModule } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { POST as createCourse } from '../route';
import { PATCH as updateCourse, DELETE as deleteCourse } from '../[slug]/route';
import { POST as createModule } from '../[slug]/modules/route';
import { PATCH as updateModule, DELETE as deleteModule } from '../[slug]/modules/[moduleId]/route';
import { PATCH as reorderModules } from '../[slug]/modules/reorder/route';
import { POST as createLesson } from '../[slug]/modules/[moduleId]/lessons/route';
import { PATCH as updateLesson, DELETE as deleteLesson } from '../[slug]/modules/[moduleId]/lessons/[lessonId]/route';
import { PATCH as reorderLessons } from '../[slug]/modules/[moduleId]/lessons/reorder/route';
import { POST as enroll } from '../[slug]/enroll/route';
import { POST as complete } from '../[slug]/lessons/[lessonId]/complete/route';

// Trusted SDK output injection only. Credential verification still uses the real
// SDK and fake HTTP kernel; no app auth/owner helper or policy is mocked.
const delegation = vi.hoisted(() => ({ actingFor: undefined as string | undefined }));
vi.mock('@ima-jin/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ima-jin/auth')>();
  return {
    ...actual,
    requireSessionOrAppToken: async (request: Request, options: Parameters<typeof actual.requireSessionOrAppToken>[1]) => {
      const result = await actual.requireSessionOrAppToken(request, options);
      if ('error' in result || !delegation.actingFor) return result;
      return { auth: { ...result.auth, actingFor: delegation.actingFor } };
    },
  };
});

const kernel = installFakeKernel();
const AGENT = 'did:imajin:agent';
const context = () => params({ slug: 'intro', moduleId: 'mod_1', lessonId: 'lsn_1' });
type Handler = (request: NextRequest, routeContext: ReturnType<typeof context>) => Promise<Response>;
interface Scenario {
  key: keyof typeof LEARN_DELEGATION_ROUTES;
  handler: Handler;
  body: Record<string, unknown>;
}
const scenarios: Scenario[] = [
  { key: 'learn.course.create', handler: createCourse, body: { title: 'New course', slug: 'new-course' } },
  { key: 'learn.course.update', handler: updateCourse, body: { title: 'New title' } },
  { key: 'learn.course.delete', handler: deleteCourse, body: {} },
  { key: 'learn.module.create', handler: createModule, body: { title: 'New module' } },
  { key: 'learn.module.update', handler: updateModule, body: { title: 'New module title' } },
  { key: 'learn.module.delete', handler: deleteModule, body: {} },
  { key: 'learn.module.reorder', handler: reorderModules, body: { order: ['mod_1'] } },
  { key: 'learn.lesson.create', handler: createLesson, body: { title: 'New lesson', content: 'Disclosed' } },
  { key: 'learn.lesson.update', handler: updateLesson, body: { content: 'Overwritten' } },
  { key: 'learn.lesson.delete', handler: deleteLesson, body: {} },
  { key: 'learn.lesson.reorder', handler: reorderLessons, body: { order: ['lsn_1'] } },
  { key: 'learn.course.enroll', handler: enroll, body: {} },
  { key: 'learn.lesson.complete', handler: complete, body: {} },
];

function requestFor(scenario: Scenario, did?: string, via = 'token', body = scenario.body) {
  const entry = LEARN_DELEGATION_ROUTES[scenario.key];
  const path = entry.path.replaceAll('[slug]', 'intro').replaceAll('[moduleId]', 'mod_1').replaceAll('[lessonId]', 'lsn_1');
  const credentials = via === 'token' ? { did } : { cookieDid: did };
  return makeRequest(entry.method, path, { ...credentials, body });
}

async function seed(creatorDid = CREATOR) {
  await seedCourse({ creatorDid });
  await seedModule();
  await seedLesson();
}

async function snapshot() {
  return Promise.all([courses, modules, lessons, enrollments, lessonProgress].map((table) => db.select().from(table)));
}

function expectedProposal(scenario: Scenario) {
  const entry = LEARN_DELEGATION_ROUTES[scenario.key];
  let resourceId: string | undefined;
  if (entry.path.includes('[slug]')) resourceId = 'intro';
  if (entry.path.includes('[moduleId]')) resourceId = 'mod_1';
  if (entry.path.includes('[lessonId]')) resourceId = 'lsn_1';
  return evaluateDelegationPolicy({ id: AGENT, actingFor: CREATOR }, {
    action: entry.action, class: entry.class, resourceId,
  });
}

afterEach(() => {
  delegation.actingFor = undefined;
  vi.restoreAllMocks();
});

describe('every classified route (#26)', () => {
  it('tests exactly the complete classified inventory', () => {
    expect(scenarios.map((scenario) => scenario.key).sort()).toEqual(Object.keys(LEARN_DELEGATION_ROUTES).sort());
  });

  describe.each(scenarios)('$key', (scenario) => {
    it.each(['token', 'cookie'])('preserves the full SDK decision for a %s delegate before effects', async (via) => {
      const decision = expectedProposal(scenario);
      // A delegate can edit its own resources on reversible routes, not impersonate an owner.
      await seed(decision.allowed ? AGENT : CREATOR);
      const before = await snapshot();
      delegation.actingFor = CREATOR;
      const reads = vi.spyOn(db, 'select');
      const inserts = vi.spyOn(db, 'insert');
      const updates = vi.spyOn(db, 'update');
      const deletes = vi.spyOn(db, 'delete');
      const response = await scenario.handler(requestFor(scenario, AGENT, via), context());
      if (decision.allowed) {
        expect(response.status).toBeGreaterThanOrEqual(200);
        expect(response.status).toBeLessThan(300);
      } else {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual(decision.body);
        expect(reads).not.toHaveBeenCalled();
        expect(inserts).not.toHaveBeenCalled();
        expect(updates).not.toHaveBeenCalled();
        expect(deletes).not.toHaveBeenCalled();
        expect(await snapshot()).toEqual(before);
        expect(kernel.calls.every((call) => call.url.endsWith('/api/tokens/app/verify') || call.url.endsWith('/api/session'))).toBe(true);
      }
    });

    it.each([undefined, CREATOR])('lets the owner reissue from their own session (actingFor=%s)', async (actingFor) => {
      await seed();
      if (scenario.key === 'learn.lesson.complete') await seedEnrollment('crs_1', CREATOR);
      delegation.actingFor = actingFor;
      const response = await scenario.handler(requestFor(scenario, CREATOR), context());
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
    });

    it('retains unauthenticated 401s before policy', async () => {
      delegation.actingFor = CREATOR;
      const response = await scenario.handler(requestFor(scenario), context());
      expect(response.status).toBe(401);
      expect(await snapshot()).toEqual([[], [], [], [], []]);
    });
  });
});

describe('alternate course PATCH execution paths', () => {
  const scenario = scenarios.find((entry) => entry.key === 'learn.course.update')!;
  it.each([
    { price: 500 }, { price: 0 }, { currency: 'USD' }, { metadata: {} }, { metadata: null },
    { metadata: { fair: { creator: OTHER } } }, { status: 'published' }, { status: 'archived' },
    { visibility: 'public' }, { title: 'Mixed', price: 1, status: 'published' },
  ])('refuses sensitive fields and caller-supplied approval flags: %j', async (body) => {
    await seed();
    const before = await snapshot();
    delegation.actingFor = CREATOR;
    const response = await updateCourse(requestFor(scenario, AGENT, 'token', { ...body, approved: true, countersigned: true }), context());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', ownerDid: CREATOR, delegateDid: AGENT, resourceId: 'intro' });
    expect(await snapshot()).toEqual(before);
  });

  it('does not reinterpret verified actingFor as ownership on reversible edits', async () => {
    await seed();
    delegation.actingFor = CREATOR;
    const response = await updateCourse(requestFor(scenario, AGENT), context());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Not authorized' });
  });

  it('fails closed for new delegated paths at authenticate and optional auth', async () => {
    delegation.actingFor = CREATOR;
    const request = makeRequest('POST', '/api/future', { did: AGENT });
    const result = await authenticate(request);
    expect(result).toMatchObject({ status: 403, proposal: { code: 'AGENT_APPROVAL_REQUIRED', action: 'unclassified-mutation' } });
    expect(await authenticateOptional(request)).toBeNull();
  });
});
