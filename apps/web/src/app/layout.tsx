import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { Geist, Geist_Mono } from 'next/font/google';
import { cn } from '@/lib/utils';
import { ThemeProvider } from '@/components/theme-provider';
import { QueryProvider } from '@/components/query-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  metadataBase: new URL('https://keel.mikulsaravanan.com'),
  title: 'KEEL · your financial system of record',
  description:
    'KEEL is an AI-first personal and entity finance system of record. A deterministic double-entry ledger, with AI that suggests and never silently acts.',
  alternates: { canonical: './' },
  openGraph: {
    title: 'KEEL · your financial system of record',
    description:
      'All of your accounts, spending, and businesses in one place. AI does the busywork and always asks before making changes.',
    url: 'https://keel.mikulsaravanan.com',
    siteName: 'KEEL',
    type: 'website',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'KEEL · your financial system of record',
    description:
      'All of your money and your business, in one place. AI does the busywork and asks before it acts.',
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
