'use client';

import type { ReactNode } from 'react';

/**
 * Replaces the in-monorepo `<OnboardGate>` (`@imajin/onboard`, not published
 * to npm — see ima-jin/imajin-ai#2646): an
 * anonymous visitor is sent through "Sign in with Imajin" (the same kernel
 * consent flow `ImajinAuthStatus` uses) instead of the inline soft-DID
 * onboarding the gate offered.
 */
export function SignInToEnroll({ className, children }: Readonly<{ className: string; children: ReactNode }>) {
  const authUrl = process.env.NEXT_PUBLIC_IMAJIN_AUTH_URL ?? '';
  const appId = process.env.NEXT_PUBLIC_IMAJIN_APP_ID ?? '';

  return (
    <a href={`${authUrl}/auth/authorize?app_id=${appId}&scopes=profile:read`} className={className}>
      {children}
    </a>
  );
}
