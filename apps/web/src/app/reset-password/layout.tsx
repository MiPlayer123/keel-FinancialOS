import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Reset password',
  robots: { index: false, follow: false },
};

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
