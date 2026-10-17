import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateDelegationPolicy } from '@ima-jin/auth/delegation-policy';
import { LEARN_DELEGATION_ROUTES, enforceOwnerMutationPolicy } from '../delegation';
import { makeRequest } from '@test/helpers';

const OWNER = 'did:imajin:owner';
const AGENT = 'did:imajin:agent';
const caller = { did: AGENT, actingFor: OWNER };
const entries = Object.entries(LEARN_DELEGATION_ROUTES);

function pathFor(path: string) {
  return path.replaceAll('[slug]', 'intro').replaceAll('[moduleId]', 'mod_1').replaceAll('[lessonId]', 'lsn_1');
}

afterEach(() => vi.unstubAllEnvs());

describe('enforceOwnerMutationPolicy at the common boundary', () => {
  it.each(entries)('%s returns exactly the published SDK decision', async (_key, policy) => {
    const resourceId = policy.path.includes('[lessonId]') ? 'lsn_1' : undefined;
    let id = resourceId;
    if (!id && policy.path.includes('[moduleId]')) id = 'mod_1';
    if (!id && policy.path.includes('[slug]')) id = 'intro';
    const expected = evaluateDelegationPolicy({ id: AGENT, actingFor: OWNER }, {
      action: policy.action, class: policy.class, resourceId: id,
    });
    const response = await enforceOwnerMutationPolicy(caller, makeRequest(policy.method, pathFor(policy.path), { body: {} }));
    if (expected.allowed) {
      expect(response).toBeNull();
    } else {
      expect(response?.status).toBe(expected.status);
      expect(await response?.json()).toEqual(expected.body);
    }
  });

  it.each(entries)('%s leaves owners and self-delegation unchanged', async (_key, policy) => {
    const request = makeRequest(policy.method, pathFor(policy.path), { body: {} });
    expect(await enforceOwnerMutationPolicy({ did: OWNER }, request)).toBeNull();
    expect(await enforceOwnerMutationPolicy({ did: OWNER, actingFor: OWNER }, request)).toBeNull();
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('allows safe %s requests', async (method) => {
    expect(await enforceOwnerMutationPolicy(caller, makeRequest(method, '/unknown'))).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('fails closed for unknown %s mutations', async (method) => {
    const response = await enforceOwnerMutationPolicy(caller, makeRequest(method, '/api/new-route'));
    const expected = evaluateDelegationPolicy({ id: AGENT, actingFor: OWNER }, { action: 'unclassified-mutation', class: 'irreversible' });
    expect(expected.allowed).toBe(false);
    if (!expected.allowed) expect(await response?.json()).toEqual(expected.body);
    expect(await enforceOwnerMutationPolicy({ did: OWNER }, makeRequest(method, '/api/new-route'))).toBeNull();
  });

  it.each([
    ['/api/courses/intro/modules/', 'unclassified-mutation'],
    ['/api/courses/intro/modules/reorder', 'reorder'],
    ['/api/courses/intro/modules/mod_1/lessons/reorder', 'reorder'],
  ])('matches literal routes and rejects empty parameters: %s', async (path, action) => {
    const response = await enforceOwnerMutationPolicy(caller, makeRequest('PATCH', path, { body: {} }));
    if (action === 'reorder') expect(response).toBeNull();
    else expect((await response?.json()).action).toBe(action);
  });

  it('normalizes only the configured base path', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/learn');
    const denied = await enforceOwnerMutationPolicy(caller, makeRequest('DELETE', '/learn/api/courses/intro'));
    expect(await denied?.json()).toMatchObject({ action: 'delete', resourceId: 'intro' });
    const unknown = await enforceOwnerMutationPolicy(caller, makeRequest('DELETE', '/learning/api/courses/intro'));
    expect(await unknown?.json()).toMatchObject({ action: 'unclassified-mutation' });
  });

  it.each([
    [{ price: 0 }, 'fair-update', 'value-moving'],
    [{ currency: 'CAD' }, 'fair-update', 'value-moving'],
    [{ metadata: {} }, 'fair-update', 'value-moving'],
    [{ metadata: null }, 'fair-update', 'value-moving'],
    [{ status: 'published' }, 'publish', 'irreversible'],
    [{ visibility: 'public' }, 'publish', 'irreversible'],
    [{ price: 0, visibility: 'public', title: 'Mixed' }, 'fair-update', 'value-moving'],
  ])('escalates sensitive course PATCH %j', async (body, action, mutationClass) => {
    const request = makeRequest('PATCH', '/api/courses/intro', { body });
    const response = await enforceOwnerMutationPolicy(caller, request);
    const expected = evaluateDelegationPolicy({ id: AGENT, actingFor: OWNER }, { action, class: mutationClass as 'value-moving' | 'irreversible', resourceId: 'intro' });
    if (!expected.allowed) expect(await response?.json()).toEqual(expected.body);
    expect(await request.json()).toEqual(body); // Policy never consumes the handler's body.
  });

  it.each(['{bad', 'null', '[]', '"text"', '{"title":"Editable"}'])('retains handler validation for %s', async (rawBody) => {
    expect(await enforceOwnerMutationPolicy(caller, makeRequest('PATCH', '/api/courses/intro', { rawBody }))).toBeNull();
  });
});
