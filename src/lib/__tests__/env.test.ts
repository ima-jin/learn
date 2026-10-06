import { afterEach, describe, expect, it, vi } from 'vitest';
import { authServiceUrl, payServiceUrl, thisAppHost } from '../env';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('thisAppHost', () => {
  it('is the host (with port) of NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dev-learn.imajin.ai/learn');
    expect(thisAppHost()).toBe('dev-learn.imajin.ai');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    expect(thisAppHost()).toBe('localhost:3000');
  });

  it('falls back to the production host when unset or malformed', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(thisAppHost()).toBe('learn.imajin.ai');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'not a url');
    expect(thisAppHost()).toBe('learn.imajin.ai');
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
