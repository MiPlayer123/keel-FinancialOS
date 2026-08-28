import type { Metadata } from 'next';

import { PublicPageShell, PublicSection } from '@/components/keel/public-page-shell';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'How the hosted KEEL pre-release handles account and financial data.',
  alternates: { canonical: '/privacy' },
  openGraph: {
    title: 'Privacy · KEEL',
    description: 'How the hosted KEEL pre-release handles account and financial data.',
    url: '/privacy',
    images: [{ url: '/opengraph-image', alt: 'KEEL · every number can show its work' }],
  },
  twitter: {
    card: 'summary',
    title: 'Privacy · KEEL',
    description: 'How the hosted KEEL pre-release handles account and financial data.',
    images: ['/opengraph-image'],
  },
};

export default function PrivacyPage() {
  return (
    <PublicPageShell
      title="Privacy"
      description="This page describes the hosted KEEL pre-release. Self-hosted operators control their own deployment and data practices."
      updated="August 28, 2026"
    >
      <PublicSection title="Data KEEL handles">
        <p>
          KEEL stores account identity information, household and entity settings, financial
          records you enter or connect, and files you upload. The hosted pre-release is
          Sandbox-only for bank connections and should be evaluated with fictional data.
        </p>
      </PublicSection>
      <PublicSection title="Why it is used">
        <p>
          Data is used to authenticate you, maintain your ledger, produce the views and
          exports you request, detect possible matches or recurring activity, and operate the
          service. KEEL does not sell financial data or use it for advertising.
        </p>
      </PublicSection>
      <PublicSection title="Service providers">
        <p>
          The hosted application uses Supabase for database, authentication, storage, and
          functions; Vercel for web hosting; and Plaid Sandbox for bank-connection testing.
          When you use the Assistant, the question and authorized tool context may be sent to
          the configured AI provider to generate a response.
        </p>
      </PublicSection>
      <PublicSection title="Control and portability">
        <p>
          Financial records can be downloaded in CSV, JSON, QIF, and Beancount formats.
          Document metadata is included in structured exports; uploaded source files remain
          separate stored objects.
        </p>
      </PublicSection>
      <PublicSection title="Questions or requests">
        <p>
          Do not post sensitive information in a public issue. Private reporting is not
          enabled yet; check the repository Security policy before sharing any private details.
        </p>
      </PublicSection>
    </PublicPageShell>
  );
}
