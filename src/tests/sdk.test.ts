import { chaosFetch, IdempotencyStore, parseRouteRule, parseTransaction, routeTransaction } from '../sdk';

describe('routing', () => {
  it('routes using explicit order when metadata is missing', () => {
    const rule = parseRouteRule({ name: 'explicit', pspOrder: ['stripe', 'adyen'], maxAttempts: 1 });
    const tx = parseTransaction({ amount: 1000, currency: 'USD', country: 'US', riskScore: 0.1 });
    const decision = routeTransaction(rule, tx, []);
    expect(decision.order).toEqual(['stripe', 'adyen']);
  });

  it('filters PSPs using metadata capability conditions', () => {
    const rule = parseRouteRule({ name: 'cap', pspOrder: ['stripe', 'adyen'], conditions: { minCapability: 80 }, fallback: 'metadata' });
    const tx = parseTransaction({ amount: 1000, currency: 'USD', country: 'US', riskScore: 0.1 });
    const metadata = [
      { psp: 'stripe' as const, capabilityScore: 92, source: 'test', indicator: 'test', value: 100, year: 2023 },
      { psp: 'adyen' as const, capabilityScore: 20, source: 'test', indicator: 'test', value: 100, year: 2023 }
    ];
    const decision = routeTransaction(rule, tx, metadata);
    expect(decision.order).toEqual(['stripe']);
  });

  it('throws when fallback aborts and no PSP is eligible', () => {
    const rule = parseRouteRule({ name: 'abort', pspOrder: ['stripe'], conditions: { country: 'US' }, fallback: 'abort' });
    const tx = parseTransaction({ amount: 1000, currency: 'USD', country: 'BR', riskScore: 0.1 });
    expect(() => routeTransaction(rule, tx, [])).toThrow('No eligible PSP');
  });
});

describe('idempotency store', () => {
  it('returns a cached successful result', () => {
    const store = new IdempotencyStore(1000);
    const result = { psp: 'stripe' as const, ok: true, reference: 'pi_123', status: 'requires_payment_method' };
    store.set(store.key('stripe', 'key-1', 'hash'), result);
    expect(store.get(store.key('stripe', 'key-1', 'hash'))).toEqual(result);
  });
});

describe('chaos middleware', () => {
  it('injects a failure when configured', async () => {
    const fetcher = async () => ({ ok: true, status: 200, text: async () => 'ok' }) as unknown as Response;
    await expect(chaosFetch(fetcher, { enabled: true, failureRate: 1 })).rejects.toThrow('Chaos fault injected');
  });
});