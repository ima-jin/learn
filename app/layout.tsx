import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ImajinAuthStatus } from '@/components/ImajinAuthStatus';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Learn — Imajin',
  description: 'Courses and lessons on the Imajin network — teach and learn, sovereign and DID-linked.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        <Providers>
          <header className="flex items-center justify-between border-b border-gray-800/50 bg-gray-950/90 px-4 py-2 backdrop-blur">
            <span className="text-sm font-semibold text-white">Imajin Learn</span>
            <ImajinAuthStatus />
          </header>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
