import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const sans = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: 'Superstar',
  description: 'Plan, review and publish social campaigns from one workspace.',
};

export const viewport: Viewport = { themeColor: '#0a0910', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" className={sans.variable}><body>{children}</body></html>;
}
