import { afterEach, describe, expect, it, vi } from 'vitest';
import { appBaseUrl, authServiceUrl, payServiceUrl, thisAppHost, webhookSecret } from '../env';

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

describe('webhookSecret', () => {
  it('reads WEBHOOK_SECRET, null when unset or empty', () => {
    vi.stubEnv('WEBHOOK_SECRET', 'shh');
    expect(webhookSecret()).toBe('shh');
    vi.stubEnv('WEBHOOK_SECRET', '');
    expect(webhookSecret()).toBeNull();
  });
});

describe('appBaseUrl', () => {
  it('is NEXT_PUBLIC_APP_URL (which already carries the base path), without a trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://jin.imajin.ai/learn');
    expect(appBaseUrl('https://ignored.test')).toBe('https://jin.imajin.ai/learn');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://jin.imajin.ai/learn/');
    expect(appBaseUrl('')).toBe('https://jin.imajin.ai/learn');
  });

  it('falls back to the request origin plus NEXT_PUBLIC_BASE_PATH', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/learn');
    expect(appBaseUrl('https://learn.test')).toBe('https://learn.test/learn');
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
    expect(appBaseUrl('https://learn.test')).toBe('https://learn.test');
  });
});
