import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { signOutAction } from './signin/actions';
import { getUser } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Insurance Service Desk',
  description: 'Case queue and evidence review for insurance broker operations. Synthetic demo data.',
};
export const viewport: Viewport = { themeColor: '#24272c' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-3 text-ink no-underline">
              <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-semibold text-accent-ink">
                S
              </span>
              <span className="text-base font-semibold tracking-tight">Insurance Service Desk</span>
            </Link>
            {user ? (
              <div className="flex items-center gap-4 text-sm">
                <span className="text-muted">
                  {user.name} <span className="pill ml-2">{user.role}</span>
                </span>
                <form action={signOutAction}>
                  <button className="btn-quiet">Sign out</button>
                </form>
              </div>
            ) : null}
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-10">{children}</main>
        <footer className="border-t border-line py-6 text-center text-xs text-muted">
          Independent proof-of-work demo, not affiliated with InsuranceDekho. All records are fictional.
        </footer>
      </body>
    </html>
  );
}
