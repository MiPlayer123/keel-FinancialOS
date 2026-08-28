import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { Geist, Geist_Mono } from 'next/font/google';
import { cn } from '@/lib/utils';
import { ThemeProvider } from '@/components/theme-provider';
import { QueryProvider } from '@/components/query-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { getSiteUrl } from '@/lib/site';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  metadataBase: getSiteUrl(),
  title: {
    default: 'KEEL · personal and entity finance on an exact ledger',
    template: '%s · KEEL',
  },
  description:
    'Open-source personal and small-business finance built on a deterministic double-entry ledger, with review-first automation and portable records.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'KEEL · personal and entity finance on an exact ledger',
    description:
      'Accounts, transactions, budgets, receipts, and entity books in one verifiable ledger.',
    url: '/',
    siteName: 'KEEL',
    type: 'website',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'KEEL · personal and entity finance on an exact ledger',
    description:
      'Open-source personal and small-business finance built on a verifiable double-entry ledger.',
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={cn(geist.variable, geistMono.variable)}>
      <body suppressHydrationWarning className="font-sans antialiased">
        <ThemeProvider>
          <QueryProvider>
            <TooltipProvider delay={200}>{children}</TooltipProvider>
            <Toaster />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
