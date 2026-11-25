import { CLASSIFICATIONS, type ModuleEngine } from '@/lib/contracts';

/**
 * STUB owned by the disclosure-checker agent: replace run() with the real engine.
 * Keep the exported name, id, route and classifications; bump promptVersion when logic changes.
 */
export const disclosureChecker: ModuleEngine = {
  id: 'disclosure-checker',
  label: 'Proposal Disclosure Checker',
  promptVersion: 'disclosure-checker-stub-0',
  classifications: CLASSIFICATIONS['disclosure-checker'],
  route: '/cases/{id}/disclosure-checker',
  async run() {
    return [];
  },
};
