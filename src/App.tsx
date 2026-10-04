import { useEffect, useMemo, useState } from 'react';
import type { PspMetadata, PspName, RouteDecision, RouteResult, RouteRule, Transaction } from './sdk';
import { PSP_NAMES, executeRoute, fetchWorldBankMetadata, parseRouteRule, parseTransaction, routeTransaction } from './sdk';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'BRL'];
const PAGE: any = { fontFamily: 'system-ui', margin: 0, padding: 24, background: '#f5f7fb', color: '#1f2937' };
const CARD: any = { background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(15, 23, 42, 0.08)' };
const BTN: any = { padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#0f172a', color: '#fff', cursor: 'pointer' };

export default function App() {
  const [order, setOrder] = useState<PspName[]>([...PSP_NAMES]);
  const [name, setName] = useState('merchant-default');
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [fallback, setFallback] = useState<'metadata' | 'first' | 'abort'>('metadata');
  const [tx, setTx] = useState<Transaction>({ amount: 10000, currency: 'USD', country: 'US', riskScore: 0.2, idempotencyKey: '' });
  const [metadata, setMetadata] = useState<PspMetadata[]>([]);
  const [error, setError] = useState('');
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [execution, setExecution] = useState<RouteResult | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    fetchWorldBankMetadata(tx.country)
      .then(items => { if (active) setMetadata(items); })
      .catch(() => { if (active) setMetadata([]); });
    return () => { active = false; };
  }, [tx.country]);

  useEffect(() => {
    const rule: RouteRule = { name, conditions: {}, pspOrder: order, maxAttempts, fallback };
    try {
      setDecision(routeTransaction(parseRouteRule(rule), tx, metadata));
      setExecution(null);
    } catch (err) {
      setError((err as Error).message);
      setDecision(null);
    }
  }, [name, order, maxAttempts, fallback, tx, metadata]);

  const updateTx = (key: keyof Transaction, value: string | number) => setTx(current => ({ ...current, [key]: value } as Transaction));

  const reorder = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) return;
    const next = [...order];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    setOrder(next);
    setDragIndex(null);
  };

  const runRoute = async () => {
    setError('');
    const rule = parseRouteRule({ name, conditions: {}, pspOrder: order, maxAttempts, fallback });
    try {
      const result = await executeRoute(rule, parseTransaction(tx), { enabled: false });
      setExecution(result);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const pspItems = useMemo(() => order.map(psp => ({ psp, meta: metadata.find(item => item.psp === psp) })), [order, metadata]);

  return (
    <div style={PAGE}>
      <h1>Multi-PSP Payment Routing Playground</h1>
      <p>Drag PSP priority, preview the routing decision, then execute sandbox calls when credentials are configured.</p>
      {error ? <pre style={{ ...CARD, color: '#b91c1c', whiteSpace: 'pre-wrap' }}>{error}</pre> : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <section style={CARD}>
          <h2>Rule builder</h2>
          <label>Name <input value={name} onChange={e => setName(e.target.value)} /></label>
          <label>Max attempts <input type='number' min={1} max={5} value={maxAttempts} onChange={e => setMaxAttempts(Number(e.target.value))} /></label>
          <label>Fallback <select value={fallback} onChange={e => setFallback(e.target.value as 'metadata' | 'first' | 'abort')}><option value='metadata'>metadata</option><option value='first'>first</option><option value='abort'>abort</option></select></label>
          <h3>PSP priority</h3>
          <ul style={{ padding: 0, margin: 0 }}>
            {pspItems.map((item, index) => (
              <li key={item.psp} draggable onDragStart={() => setDragIndex(index)} onDragOver={e => e.preventDefault()} onDrop={() => reorder(index)} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, margin: 8, cursor: 'grab', display: 'flex', justifyContent: 'space-between' }}>
                <span>{index + 1}. {item.psp}</span>
                <small>{item.meta ? `${item.meta.capabilityScore} score` : 'no metadata'}</small>
              </li>
            ))}
          </ul>
          <pre style={{ ...CARD, height: 160, overflow: 'auto' }}>{JSON.stringify({ name, pspOrder: order, maxAttempts, fallback }, null, 2)}</pre>
        </section>
        <section style={CARD}>
          <h2>Transaction</h2>
          <label>Amount (cents) <input type='number' min={1} value={tx.amount} onChange={e => updateTx('amount', Number(e.target.value))} /></label>
          <label>Currency <select value={tx.currency} onChange={e => updateTx('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          <label>Country ISO <input value={tx.country} onChange={e => updateTx('country', e.target.value.toUpperCase())} /></label>
          <label>Risk score <input type='number' step='0.01' min={0} max={1} value={tx.riskScore} onChange={e => updateTx('riskScore', Number(e.target.value))} /></label>
          <button style={BTN} onClick={runRoute}>Execute routing</button>
          <h2>Decision</h2>
          <pre style={{ ...CARD }}>{decision ? JSON.stringify(decision, null, 2) : 'No decision yet.'}</pre>
          <h2>Execution</h2>
          <pre style={{ ...CARD, height: 220, overflow: 'auto' }}>{execution ? JSON.stringify(execution, null, 2) : 'No execution yet.'}</pre>
        </section>
      </div>
    </div>
  );
}