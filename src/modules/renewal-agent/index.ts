import { CLASSIFICATIONS, type ModuleEngine } from '@/lib/contracts';

/**
 * STUB owned by the renewal-agent agent: replace run() with the real engine.
 * Keep the exported name, id, route and classifications; bump promptVersion when logic changes.
 */
export const renewalAgent: ModuleEngine = {
  id: 'renewal-agent',
  label: 'Renewal Terms Change Agent',
  promptVersion: 'renewal-agent-stub-0',
  classifications: CLASSIFICATIONS['renewal-agent'],
  route: '/cases/{id}/renewal-agent',
  async run() {
    return [];
  },
};
