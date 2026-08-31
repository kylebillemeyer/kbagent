import type { ReactNode } from 'react';

export const metadata = { title: 'kbagent' };

/**
 * Placeholder shell. PR 3b builds the actual UI — this exists only because Next
 * requires a root layout and a page for `next build` to succeed on an API-only app.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
