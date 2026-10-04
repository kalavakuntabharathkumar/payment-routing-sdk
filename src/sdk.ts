import { z } from 'zod';

// The five sandbox PSPs supported by this portfolio SDK.
export const PSP_NAMES = ['stripe', 'adyen', 'braintree', 'square', 'checkout'] as const;
export type PspName = typeof PSP_NAMES[number];

export const TransactionSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  country: z.string().length(2),
  riskScore: z.number().min(0).max(1),
  idempotencyKey: z.string().optional()
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const RouteRuleSchema = z.object({
  name: z.string().min(1),
  conditions: z.object({
    country: z.string().optional(),
    currency: z.string().optional(),
    minAmount: z.number().int().positive().optional(),
    maxRisk: z.number().min(0).max(1).optional(),
    minCapability: z.number().min(0).max(100).optional()
  }).default({}),
  pspOrder: z.array(z.enum(PSP_NAMES)).min(1),
  maxAttempts: z.number().int().min(1).max(5).default(2),
  fallback: z.enum(['metadata', 'first', 'abort']).default('metadata')
});
export type RouteRule = z.infer<typeof RouteRuleSchema>;

export interface PspMetadata {
  psp: PspName;
  capabilityScore: number;
  source: string;
  indicator: string;
  value: number;
  year: number;
}

export interface RouteDecision {
  rule: string;
  order: PspName[];
  reason: string;
}

export interface PspResult {
  psp: PspName;
  ok: boolean;
  reference?: string;
  status?: string;
  error?: string;
}

export interface RouteResult {
  ok: boolean;
  psp?: PspName;
  reference?: string;
  status?: string;
  attempts: PspResult[];
  error?: string;
}

export const parseTransaction = (input: unknown) => TransactionSchema.parse(input);
export const parseRouteRule = (input: unknown) => RouteRuleSchema.parse(input);

function env(name: string): string | undefined {
  // Credentials are read from the Node environment only.
  return typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
}

function requireKey(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing ${name}. Configure the environment before running a live sandbox call.`);
  return value;
}

function newIdempotencyKey(): string {
  const c: any = globalThis;
  if (c?.crypto?.randomUUID) return c.crypto.randomUUID();
  return `pay-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
}

function hashPayload(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

// Keep a bounded cache so duplicate idempotency keys do not create duplicate charges.
export class IdempotencyStore {
  private cache = new Map<string, { result: PspResult; createdAt: number }>();
  private ttlMs: number;
  constructor(ttlMs = 10 * 60 * 1000) { this.ttlMs = ttlMs; }
  key(psp: PspName, idempotencyKey: string, payloadHash: string): string { return `${psp}|${idempotencyKey}|${payloadHash}`; }
  get(key: string): PspResult | undefined {
    const item = this.cache.get(key);
    if (!item) return undefined;
    if (Date.now() - item.createdAt > this.ttlMs) this.cache.delete(key);
    else return item.result;
  }
  set(key: string, result: PspResult): void {
    this.cache.set(key, { result, createdAt: Date.now() });
    if (this.cache.size > 500) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
  }
}

export const idempotencyStore = new IdempotencyStore();

export interface ChaosConfig {
  enabled: boolean;
  delayMs?: number;
  failureRate?: number;
}

// Chaos wrapper used by local tests and fault-injection validation.
export async function chaosFetch(fetcher: () => Promise<Response>, config: ChaosConfig): Promise<Response> {
  if (!config.enabled) return fetcher();
  if (config.delayMs && config.delayMs > 0) await new Promise(resolve => setTimeout(resolve, config.delayMs));
  if (config.failureRate && Math.random() < config.failureRate) throw new Error('Chaos fault injected');
  return fetcher();
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, chaos: ChaosConfig = { enabled: false }): Promise<Response> {
  return chaosFetch(() => fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), chaos);
}

export async function fetchWorldBankMetadata(country = 'US'): Promise<PspMetadata[]> {
  const base = typeof document !== 'undefined' ? '/worldbank' : 'https://api.worldbank.org';
  const url = `${base}/v2/country/${encodeURIComponent(country.toUpperCase())}/indicator/FI.ART.POPS?format=json&date=2023&per_page=1`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new Error(`World Bank network error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`World Bank responded with ${response.status}`);
  const json: any = await response.json();
  const row = json?.[1]?.[0];
  if (!row || row.value === null || row.value === undefined) throw new Error('World Bank returned no 2023 value for this country.');
  const score = Math.max(0, Math.min(100, Number(row.value)));
  return PSP_NAMES.map(psp => ({ psp, capabilityScore: Number((0.35 + 0.65 * (score / 100)).toFixed(2)), source: 'World Bank Global Payment Systems Survey 2023', indicator: 'FI.ART.POPS', value: Number(row.value), year: Number(row.date) || 2023 }));
}

export function routeTransaction(rule: RouteRule, tx: Transaction, metadata: PspMetadata[] = []): RouteDecision {
  const reasons: string[] = [];
  const c = rule.conditions;
  let matches = true;
  if (c.country && c.country.toUpperCase() !== tx.country.toUpperCase()) matches = false;
  if (c.currency && c.currency.toUpperCase() !== tx.currency.toUpperCase()) matches = false;
  if (c.minAmount && tx.amount < c.minAmount) matches = false;
  if (c.maxRisk !== undefined && tx.riskScore > c.maxRisk) matches = false;

  const eligible = metadata.filter(item => !c.minCapability || item.capabilityScore >= c.minCapability);
  let order = rule.pspOrder.filter(psp => eligible.length === 0 || eligible.some(item => item.psp === psp));

  if (!matches) {
    reasons.push('transaction did not match rule conditions');
    if (rule.fallback === 'abort') order = [];
    else if (rule.fallback === 'first') order = [rule.pspOrder[0]];
    else order = eligible.length ? eligible.map(item => item.psp).sort((a, b) => (metadata.find(i => i.psp === b)?.capabilityScore ?? 0) - (metadata.find(i => i.psp === a)?.capabilityScore ?? 0)) : rule.pspOrder;
  } else {
    if (c.minCapability) reasons.push(`capability >= ${c.minCapability}`);
    if (c.country) reasons.push(`country ${tx.country}`);
    if (c.currency) reasons.push(`currency ${tx.currency}`);
    if (c.minAmount) reasons.push(`amount >= ${c.minAmount}`);
    if (c.maxRisk !== undefined) reasons.push(`risk <= ${c.maxRisk}`);
  }

  if (order.length === 0) throw new Error(`No eligible PSP for rule ${rule.name}. Check conditions or fallback.`);
  return { rule: rule.name, order, reason: reasons.join(', ') || 'using configured priority' };
}

function isRetryable(message?: string): boolean {
  if (!message) return false;
  return /ECONNRESET|ETIMEDOUT|timeout|429|500|502|503|network/i.test(message);
}

// Each PSP adapter maps the unified transaction to its sandbox API.
export async function executePsp(psp: PspName, tx: Transaction, idempotencyKey: string, chaos: ChaosConfig = { enabled: false }, store = idempotencyStore): Promise<PspResult> {
  const cacheKey = store.key(psp, idempotencyKey, hashPayload(tx));
  const cached = store.get(cacheKey);
  if (cached) return cached;

  try {
    let reference = '';
    let status = '';
    let response: Response;

    if (psp === 'stripe') {
      const key = requireKey('STRIPE_TEST_KEY');
      response = await postJson('https://api.stripe.com/v1/payment_intents', { Authorization: `Bearer ${key}`, 'Idempotency-Key': idempotencyKey }, { amount: tx.amount, currency: tx.currency.toLowerCase(), payment_method_types: ['card'], capture_method: 'automatic' }, chaos);
      if (!response.ok) throw new Error(`Stripe ${response.status}: ${await response.text()}`);
      const json: any = await response.json();
      reference = json.id;
      status = json.status;
    } else if (psp === 'adyen') {
      const key = requireKey('ADYEN_X_API_KEY');
      const merchant = requireKey('ADYEN_MERCHANT_ACCOUNT');
      response = await postJson('https://checkout.adyen.com/payments', { 'x-api-key': key, 'X-Idempotency-Key': idempotencyKey }, { amount: { value: tx.amount, currency: tx.currency }, reference: `playground-${idempotencyKey}`, merchantAccount: merchant, paymentMethod: { type: 'card', number: '4111111111111111', expiryMonth: '03', expiryYear: '2030', cvc: '737' } }, chaos);
      if (!response.ok) throw new Error(`Adyen ${response.status}: ${await response.text()}`);
      const json: any = await response.json();
      reference = json.pspReference;
      status = json.result;
    } else if (psp === 'braintree') {
      const key = requireKey('BRAINTREE_ACCESS_TOKEN');
      response = await postJson('https://api.sandbox.braintreegateway.com/v1/transactions/sale', { Authorization: `Bearer ${key}` }, { transaction: { amount: (tx.amount / 100).toFixed(2), currencyCode: tx.currency, channelId: 'web' }, creditCard: { number: '4111111111111111', verificationValue: '737', expirationMonth: '03', expirationYear: '2030' } }, chaos);
      if (!response.ok) throw new Error(`Braintree ${response.status}: ${await response.text()}`);
      const json: any = await response.json();
      reference = json.transaction?.id;
      status = json.transaction?.status;
    } else if (psp === 'square') {
      const key = requireKey('SQUARE_SANDBOX_ACCESS_TOKEN');
      response = await postJson('https://connect.sandbox.squareup.com/v2/payments', { Authorization: `Bearer ${key}`, 'Idempotency-Key': idempotencyKey }, { amountMoney: { amount: (tx.amount / 100).toFixed(2), currency: tx.currency }, idempotencyKey, cardDetails: { cardNonce: 'CCFAXX' } }, chaos);
      if (!response.ok) throw new Error(`Square ${response.status}: ${await response.text()}`);
      const json: any = await response.json();
      reference = json.payment?.id;
      status = json.payment?.status;
    } else if (psp === 'checkout') {
      const key = requireKey('CHECKOUT_SECRET_KEY');
      const merchant = requireKey('CHECKOUT_MERCHANT_ID');
      response = await postJson('https://api.sandbox.checkout.com/payments', { Authorization: `Bearer ${key}`, 'X-Idempotency-Key': idempotencyKey }, { amount: tx.amount, currency: tx.currency, source: { type: 'card', number: '4111111111111111', expiry_month: '03', expiry_year: '2030', cvc: '737', name: 'Playground Test', billing_descriptor: 'Playground' }, capture: 'true' }, chaos);
      if (!response.ok) throw new Error(`Checkout ${response.status}: ${await response.text()}`);
      const json: any = await response.json();
      reference = json.id;
      status = json.status;
    } else {
      throw new Error(`Unknown PSP ${psp}`);
    }

    const result: PspResult = { psp, ok: true, reference, status };
    store.set(cacheKey, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { psp, ok: false, error: message };
  }
}

export async function executeRoute(rule: RouteRule, tx: Transaction, chaos: ChaosConfig = { enabled: false }, store = idempotencyStore): Promise<RouteResult> {
  const metadata = await fetchWorldBankMetadata(tx.country).catch(() => [] as PspMetadata[]);
  const decision = routeTransaction(rule, tx, metadata);
  const key = tx.idempotencyKey || newIdempotencyKey();
  const attempts: PspResult[] = [];

  for (const psp of decision.order) {
    for (let attempt = 1; attempt <= rule.maxAttempts; attempt += 1) {
      const result = await executePsp(psp, tx, key, chaos, store);
      attempts.push(result);
      if (result.ok) return { ok: true, psp, reference: result.reference, status: result.status, attempts };
      if (!isRetryable(result.error) && attempt === 1) break;
      if (attempt < rule.maxAttempts && isRetryable(result.error)) {
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        continue;
      }
      break;
    }
  }

  return { ok: false, attempts, error: 'All PSP attempts failed or no eligible PSP was available.' };
}