import type { Finding, ModelProvider, ModelRequest } from '../contracts';
import { validateModelOutput } from './validate';

export * from './prompt';
export * from './providers';
export * from './validate';
export * from './verify';

/**
 * What engines call: send the request, validate the structured output against the module's
 * classification set. Citation verification is applied afterwards by the review orchestrator,
 * so an engine cannot skip it.
 */
export async function runModelTask(
  provider: ModelProvider,
  req: ModelRequest,
  classifications: readonly string[],
): Promise<Finding[]> {
  const result = await provider.complete(req);
  return validateModelOutput(result.output, classifications);
}
