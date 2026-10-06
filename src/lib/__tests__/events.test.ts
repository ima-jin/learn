import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitLearnEvent, type LearnEventInput } from '../events';
import { getSigningIdentity } from '../signing-identity';
import { AUTH_URL, installFakeKernel } from '@test/kernel';

vi.mock('../signing-identity', () => ({ getSigningIdentity: vi.fn() }));

const kernel = installFakeKernel();

const input = (appToken: string | null): LearnEventInput => ({
  type: 'learn.enrolled',
  caller: { did: 'did:imajin:s', scopes: [], via: appToken ? 'token' : 'cookie', appToken },
  courseId: 'crs_1',
  courseTitle: 'Intro',
  creatorDid: 'did:imajin:c',
  payload: { enrolled_at: '2026-01-01T00:00:00.000Z' },
});

beforeEach(() => {
  vi.mocked(getSigningIdentity).mockReturnValue({ appDid: 'did:imajin:app', privateKey: '22'.repeat(32), publicKey: null });
});

describe('emitLearnEvent', () => {
  it('submits an app-signed attestation delegated by the caller, with the caller\'s token', async () => {
    expect(await emitLearnEvent(input('tok:did:imajin:s'))).toBe(true);
    const call = kernel.calls.find((c) => c.url === `${AUTH_URL}/api/attestations`);
    expect(call?.headers.authorization).toBe('Bearer tok:did:imajin:s');
    expect(call?.body).toMatchObject({
      issuer_did: 'did:imajin:app',
      subject_did: 'did:imajin:s',
      type: 'learn.enrolled',
      context_id: 'crs_1',
      context_type: 'course',
      payload: {
        delegator_did: 'did:imajin:s',
        scope: 'learn',
        creator_did: 'did:imajin:c',
        course_title: 'Intro',
        enrolled_at: '2026-01-01T00:00:00.000Z',
      },
    });
    expect((call?.body as { signature: string }).signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it('does nothing without an app token (cookie path) or without an auth service', async () => {
    expect(await emitLearnEvent(input(null))).toBe(false);
    vi.stubEnv('AUTH_SERVICE_URL', '');
    expect(await emitLearnEvent(input('tok:x'))).toBe(false);
    vi.unstubAllEnvs();
    expect(kernel.calls.filter((c) => c.url.endsWith('/api/attestations'))).toHaveLength(0);
  });

  it('reports false, never throws, when the kernel refuses', async () => {
    kernel.respond.set('/api/attestations', () => Response.json({ error: 'no grant' }, { status: 403 }));
    expect(await emitLearnEvent(input('tok:x'))).toBe(false);
  });

  it('reports false, never throws, when the signing identity is not bootstrapped', async () => {
    vi.mocked(getSigningIdentity).mockImplementation(() => {
      throw new Error('not bootstrapped');
    });
    expect(await emitLearnEvent(input('tok:x'))).toBe(false);
  });
});
