import type { Metadata } from 'next';

import { PublicPageShell, PublicSection } from '@/components/keel/public-page-shell';

export const metadata: Metadata = {
  title: 'Security',
  description: 'KEEL security architecture, current limitations, and responsible disclosure.',
  alternates: { canonical: '/security' },
};

export default function SecurityPage() {
  return (
    <PublicPageShell
      title="Security"
      description="KEEL is designed so financial calculations, authorization, and AI behavior remain separate and reviewable."
      updated="August 28, 2026"
    >
      <PublicSection title="Current status">
        <p>
          KEEL is pre-release software. It has not been represented as independently audited,
          certified, or suitable for production bank credentials. The hosted bank connection
          is restricted to Plaid Sandbox.
        </p>
      </PublicSection>
      <PublicSection title="Architecture">
        <p>
          Supabase Auth identifies users. Household and entity authorization is enforced in
          the shared domain boundary and rechecked by database policies or procedures.
          Canonical financial writes go through authenticated functions rather than direct
          browser writes.
        </p>
        <p>
          Money is stored as integer minor units. Journal entries must balance per currency,
          and corrections use revisions or compensating entries instead of rewriting posted
          history.
        </p>
      </PublicSection>
      <PublicSection title="AI boundary">
        <p>
          Language models do not perform ledger arithmetic. Imported memos, documents, and
          other ingested text are treated as untrusted data. The hosted Assistant is currently
          read-only while payload-bound approvals are being completed.
        </p>
      </PublicSection>
      <PublicSection title="Secrets and providers">
        <p>
          Provider credentials and Supabase secret keys belong in server-side secret stores,
          never in browser bundles or the repository. Plaid access tokens are stored in
          encrypted server-side envelopes.
        </p>
      </PublicSection>
      <PublicSection title="Report a vulnerability">
        <p>
          Use GitHub&apos;s private vulnerability reporting on the KEEL repository. Do not
          open a public issue containing exploit details, credentials, or financial data.
        </p>
        <p>
          <a
            href="https://github.com/MiPlayer123/keel-FinancialOS/security"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Open the repository Security page
          </a>
        </p>
      </PublicSection>
    </PublicPageShell>
  );
}
