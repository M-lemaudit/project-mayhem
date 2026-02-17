import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Blacklane Sniper Admin',
  description: 'Admin dashboard for Blacklane Sniper bots',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
