'use client';

import type { ReactNode } from 'react';
import { ToastProvider } from '@ima-jin/ui';

/**
 * Extension point for client-side context providers. Learn's pages use the
 * published `@ima-jin/ui` toast.
 */
export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return <ToastProvider>{children}</ToastProvider>;
}
