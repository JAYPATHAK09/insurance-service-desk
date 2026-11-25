import { CLASSIFICATIONS, type ModuleEngine } from '@/lib/contracts';

/**
 * STUB owned by the claim-reconciler agent: replace run() with the real engine.
 * Keep the exported name, id, route and classifications; bump promptVersion when logic changes.
 */
export const claimReconciler: ModuleEngine = {
  id: 'claim-reconciler',
  label: 'Claim Query Reconciler',
  promptVersion: 'claim-reconciler-stub-0',
  classifications: CLASSIFICATIONS['claim-reconciler'],
  route: '/cases/{id}/claim-reconciler',
  async run() {
    return [];
  },
};
