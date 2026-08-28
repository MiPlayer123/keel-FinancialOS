import type { Metadata } from 'next';

import { PublicPageShell, PublicSection } from '@/components/keel/public-page-shell';

export const metadata: Metadata = {
  title: 'Terms',
  description: 'Terms for evaluating the hosted KEEL pre-release.',
  alternates: { canonical: '/terms' },
};

export default function TermsPage() {
  return (
    <PublicPageShell
      title="Terms of use"
      description="These terms apply to the hosted KEEL pre-release. The open-source code is licensed separately under AGPL-3.0."
      updated="August 28, 2026"
    >
      <PublicSection title="Pre-release service">
        <p>
          KEEL is under active development and may change, fail, or produce incomplete
          results. The hosted service is for evaluation with fictional data and Plaid Sandbox,
          not as a substitute for your bank, accountant, tax professional, lawyer, or
          investment adviser.
        </p>
      </PublicSection>
      <PublicSection title="Your responsibilities">
        <p>
          Keep your sign-in credentials secure, use only data you are authorized to use, and
          do not attempt to disrupt the service or access another household. Verify material
          financial decisions against original records and qualified professionals.
        </p>
      </PublicSection>
      <PublicSection title="Your data">
        <p>
          You retain ownership of data you provide. You grant the hosted service permission
          to process it only as needed to operate the features you request. The Privacy page
          describes the current providers and data handling.
        </p>
      </PublicSection>
      <PublicSection title="No warranty">
        <p>
          The hosted pre-release is provided as available, without warranties of accuracy,
          availability, fitness for a particular purpose, or non-infringement to the extent
          permitted by law.
        </p>
      </PublicSection>
      <PublicSection title="Open-source license">
        <p>
          The source repository is distributed under the GNU Affero General Public License
          version 3. Use, modification, and distribution of that code are governed by the
          license in the repository, not by these hosted-service terms.
        </p>
      </PublicSection>
      <PublicSection title="Changes">
        <p>
          These terms may be updated as the product matures. A new date will appear above
          when the text changes materially.
        </p>
      </PublicSection>
    </PublicPageShell>
  );
}
