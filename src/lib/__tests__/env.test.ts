import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_SLUG,
  appBaseUrl,
  authServiceUrl,
  payServiceUrl,
  webhookSecret,
} from '../env';

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
