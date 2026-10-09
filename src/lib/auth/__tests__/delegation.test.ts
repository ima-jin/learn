import { DELEGATION_ROUTES } from '@ima-jin/auth/delegation-policy';
import { describe, expect, it } from 'vitest';
import { type LearnDeleteRouteKey, enforceOwnerMutationPolicy } from '../delegation';

const OWNER = 'did:imajin:owner';
const AGENT = 'did:imajin:agent';
const KEYS: LearnDeleteRouteKey[] = ['learn.course.delete', 'learn.module.delete', 'learn.lesson.delete'];

describe('learn delegation-policy registry', () => {
  it.each(KEYS)('%s is an irreversible learn mutation', (key) => {
    expect(DELEGATION_ROUTES[key]).toMatchObject({ app: 'learn', class: 'irreversible', action: 'delete' });
  });
});

describe('enforceOwnerMutationPolicy', () => {
  it.each(KEYS)('denies an agent delegate on %s with AGENT_APPROVAL_REQUIRED', async (key) => {
    const res = enforceOwnerMutationPolicy({ did: AGENT, actingFor: OWNER }, key, 'res_1');
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({
      code: 'AGENT_APPROVAL_REQUIRED',
      action: 'delete',
      class: 'irreversible',
      resourceId: 'res_1',
      ownerDid: OWNER,
      delegateDid: AGENT,
    });
  });

  it('allows the owner acting as themselves', () => {
    expect(enforceOwnerMutationPolicy({ did: OWNER }, 'learn.course.delete', 'intro')).toBeNull();
    expect(enforceOwnerMutationPolicy({ did: OWNER, actingFor: null }, 'learn.course.delete', 'intro')).toBeNull();
  });

  it('treats self-delegation as the owner, not a delegate', () => {
    expect(enforceOwnerMutationPolicy({ did: OWNER, actingFor: OWNER }, 'learn.module.delete', 'mod_1')).toBeNull();
  });
});
