import type { ModuleEngine, ModuleId } from '@/lib/contracts';
import { claimReconciler } from './claim-reconciler';
import { disclosureChecker } from './disclosure-checker';
import { renewalAgent } from './renewal-agent';

/** Add a module here (one line) and nowhere else. */
const ENGINES: Record<ModuleId, ModuleEngine> = {
  'claim-reconciler': claimReconciler,
  'disclosure-checker': disclosureChecker,
  'renewal-agent': renewalAgent,
};

export const getModule = (id: ModuleId): ModuleEngine => ENGINES[id];
export const listModules = (): ModuleEngine[] => Object.values(ENGINES);
export const moduleRoute = (id: ModuleId, caseId: string) => ENGINES[id].route.replace('{id}', caseId);
