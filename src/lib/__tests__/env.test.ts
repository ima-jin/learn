import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_SLUG, authServiceUrl, payServiceUrl } from '../env';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('APP_SLUG', () => {
  it('is the registry slug, independent of NEXT_PUBLIC_APP_URL (imajin-ai#2706)', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dev-jin.imajin.ai/learn');
    expect(APP_SLUG).toBe('learn');
  });
});

describe('authServiceUrl', () => {
  it('reads AUTH_SERVICE_URL, null when unset', () => {
    vi.stubEnv('AUTH_SERVICE_URL', 'https://k.test/auth');
    expect(authServiceUrl()).toBe('https://k.test/auth');
    vi.stubEnv('AUTH_SERVICE_URL', '');
    expect(authServiceUrl()).toBeNull();
  });
});

describe('payServiceUrl', () => {
  it('prefers PAY_SERVICE_URL, then derives from IMAJIN_KERNEL_URL, else null', () => {
    vi.stubEnv('PAY_SERVICE_URL', 'https://k.test/pay');
    expect(payServiceUrl()).toBe('https://k.test/pay');
    vi.stubEnv('PAY_SERVICE_URL', '');
    vi.stubEnv('IMAJIN_KERNEL_URL', 'https://k.test');
    expect(payServiceUrl()).toBe('https://k.test/pay');
    vi.stubEnv('IMAJIN_KERNEL_URL', '');
    expect(payServiceUrl()).toBeNull();
  });
});
