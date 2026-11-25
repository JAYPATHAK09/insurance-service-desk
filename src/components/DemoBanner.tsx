import { DEMO_BANNER_TEXT, isDemoPublic } from '@/lib/env';

/** Persistent notice on every page (rendered by the root layout, so sign-in shows it too). */
export function DemoBanner() {
  if (!isDemoPublic()) return null;
  return (
    <div role="note" data-testid="demo-banner" className="bg-accent px-6 py-2 text-center text-sm font-medium text-accent-ink">
      {DEMO_BANNER_TEXT}. Do not enter real personal or policy information.
    </div>
  );
}
