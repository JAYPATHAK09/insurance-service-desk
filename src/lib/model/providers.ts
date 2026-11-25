import { createHash, createHmac } from 'node:crypto';
import type { ModelProvider, ModelRequest, ModelResult } from '../contracts';
import { isDemoPublic } from '../env';
import { log } from '../log';
import { buildPrompt } from './prompt';

// ---------- Synthetic (deterministic, no network) ----------

export type SyntheticHandler = (req: ModelRequest) => unknown;
const handlers = new Map<string, SyntheticHandler>();

/** Module engines register a deterministic, rule-based handler per task id. */
export function registerSyntheticHandler(task: string, fn: SyntheticHandler): void {
  handlers.set(task, fn);
}

export const SYNTHETIC_MODEL_ID = 'synthetic-v1';

export class SyntheticProvider implements ModelProvider {
  readonly mode = 'synthetic' as const;
  readonly model = SYNTHETIC_MODEL_ID;
  async complete(req: ModelRequest): Promise<ModelResult> {
    const out = handlers.get(req.task)?.(req) ?? { findings: [] };
    return { mode: 'synthetic', model: this.model, promptVersion: req.promptVersion, output: out };
  }
}

// ---------- Anthropic API ----------

const MAX_TOKENS = 4096;
const TIMEOUT_MS = 60_000;

/** Errors deliberately omit response bodies: they may echo document text. */
export class ModelCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCallError';
  }
}

export class AnthropicProvider implements ModelProvider {
  readonly mode = 'live' as const;
  constructor(
    private apiKey: string,
    readonly model: string,
  ) {}
  async complete(req: ModelRequest): Promise<ModelResult> {
    const { system, user } = buildPrompt(req);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.model, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new ModelCallError(`Anthropic API returned ${res.status}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((c) => c.type === 'text')?.text;
    if (!text) throw new ModelCallError('Anthropic API returned no text');
    return { mode: 'live', model: this.model, promptVersion: req.promptVersion, output: text };
  }
}

// ---------- Amazon Bedrock (SigV4 over fetch, no SDK) ----------

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();

export function sigV4Headers(args: {
  method: string;
  host: string;
  path: string; // already URI-encoded as sent on the wire
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now?: Date;
}): Record<string, string> {
  const now = args.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(args.body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: args.host,
    'x-amz-date': amzDate,
  };
  if (args.sessionToken) headers['x-amz-security-token'] = args.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  // Non-S3 services: the path is URI-encoded a second time in the canonical request.
  const canonicalPath = args.path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const canonicalRequest = [args.method, canonicalPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${args.region}/${args.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${args.secretAccessKey}`, date);
  const key = hmac(hmac(hmac(kDate, args.region), args.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

export class BedrockProvider implements ModelProvider {
  readonly mode = 'live' as const;
  constructor(
    private cfg: { region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string },
    readonly model: string,
  ) {}
  async complete(req: ModelRequest): Promise<ModelResult> {
    const { system, user } = buildPrompt(req);
    const host = `bedrock-runtime.${this.cfg.region}.amazonaws.com`;
    const path = `/model/${encodeURIComponent(this.model)}/invoke`;
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const headers = sigV4Headers({ method: 'POST', host, path, body, service: 'bedrock', ...this.cfg });
    const res = await fetch(`https://${host}${path}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new ModelCallError(`Bedrock returned ${res.status}`);
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((c) => c.type === 'text')?.text;
    if (!text) throw new ModelCallError('Bedrock returned no text');
    return { mode: 'live', model: this.model, promptVersion: req.promptVersion, output: text };
  }
}

// ---------- Selection ----------

export function liveProvidersConfigured(): { anthropic: boolean; bedrock: boolean } {
  const e = process.env;
  return {
    anthropic: Boolean(e.ANTHROPIC_API_KEY),
    bedrock: Boolean(e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY && e.AWS_REGION && e.BEDROCK_MODEL_ID),
  };
}

/**
 * MODEL_PROVIDER = synthetic (default) | anthropic | bedrock. A live provider is used only when
 * explicitly selected AND configured; otherwise we throw rather than silently falling back, so a
 * result is never mislabelled.
 */
let demoNoticeLogged = false;

export function getProvider(): ModelProvider {
  const e = process.env;
  const choice = (e.MODEL_PROVIDER ?? 'synthetic').toLowerCase();
  if (choice === 'synthetic') return new SyntheticProvider();
  if (isDemoPublic()) {
    // Public demo: never reach a paid or live model, whatever else is configured. No secrets are logged.
    if (!demoNoticeLogged) {
      demoNoticeLogged = true;
      log('warn', 'model.live_provider_refused', { reason: 'DEMO_PUBLIC=true, using synthetic model' });
    }
    return new SyntheticProvider();
  }
  const cfg = liveProvidersConfigured();
  if (choice === 'anthropic') {
    if (!cfg.anthropic) throw new ModelCallError('MODEL_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
    return new AnthropicProvider(e.ANTHROPIC_API_KEY as string, e.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5');
  }
  if (choice === 'bedrock') {
    if (!cfg.bedrock) throw new ModelCallError('MODEL_PROVIDER=bedrock but AWS credentials/region/model are not set');
    return new BedrockProvider(
      {
        region: e.AWS_REGION as string,
        accessKeyId: e.AWS_ACCESS_KEY_ID as string,
        secretAccessKey: e.AWS_SECRET_ACCESS_KEY as string,
        sessionToken: e.AWS_SESSION_TOKEN,
      },
      e.BEDROCK_MODEL_ID as string,
    );
  }
  throw new ModelCallError(`Unknown MODEL_PROVIDER "${choice}"`);
}
