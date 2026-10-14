import { KernelWebhookError, verifyKernelWebhook } from '@ima-jin/auth/kernel-webhook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, enrollments, lessonProgress } from '@/db';
import { makeRequest } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { POST } from '../route';

// Fault injection complements the real Ed25519/SDK verification tests in route.test.ts.
vi.mock('@ima-jin/auth/kernel-webhook', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth/kernel-webhook')>(),
  verifyKernelWebhook: vi.fn(),
}));

const kernel = installFakeKernel();

beforeEach(() => {
  vi.mocked(verifyKernelWebhook).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/webhook — retryable verification failures', () => {
  it.each(['STORE', 'DISCOVERY', 'TRUST'] as const)('returns 503 for %s with no business effects', async (code) => {
    vi.mocked(verifyKernelWebhook).mockRejectedValueOnce(new KernelWebhookError(code, 'Injected infrastructure failure'));
    const select = vi.spyOn(db, 'select');
    const transaction = vi.spyOn(db, 'transaction');

    const response = await POST(makeRequest('POST', '/api/webhook', { body: { type: 'payment.succeeded' } }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Webhook verification unavailable' });
    expect(select).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(kernel.calls).toEqual([]);
    expect(await db.select().from(enrollments)).toHaveLength(0);
    expect(await db.select().from(lessonProgress)).toHaveLength(0);
  });

  it('returns 503 for an unexpected verifier failure, matching coffee', async () => {
    vi.mocked(verifyKernelWebhook).mockRejectedValueOnce(new Error('Unexpected verification failure'));
    const transaction = vi.spyOn(db, 'transaction');

    const response = await POST(makeRequest('POST', '/api/webhook', { body: { type: 'payment.succeeded' } }));

    expect(response.status).toBe(503);
    expect(transaction).not.toHaveBeenCalled();
    expect(kernel.calls).toEqual([]);
  });
});
