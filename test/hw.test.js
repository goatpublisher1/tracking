const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarHw, traduzirStatus } = require('../hw');

// Corpo de exemplo, com os nomes de campo do postback salvo na H&W (os padrao dela).
function b(extra = {}) {
  return {
    oferta: 'off_6847681',
    order_number: 'ORD-1001',
    order_status: 'PAID',
    order_type: 'FRONT',
    order_payout: 100,
    order_currency: 'USD',
    order_paid_at: '2026-11-05T15:01:33.166Z',
    order_created_at: '2026-11-05T15:00:10.000Z',
    product_name: 'EreVanton',
    sck: 'idx_mh5k2p_abc123def',
    order_checkout_url: 'https://order.wealthpay.io/sca1ml7aemkd?affid=aff8022827&sck=idx_outro_xyz',
    utm_source: 'FB',
    utm_campaign: 'SWH | ABO|120230000000000001',
    utm_medium: 'Conjunto|120230000000000002',
    utm_content: 'AD01|120230000000000003',
    utm_term: 'Facebook_Mobile_Feed',
    ...extra,
  };
}
const q = { funil: 'chemistrysystem-fb1', token: 'x' };

test('a comissao vira value; txId e productCode levam o prefixo hw_', () => {
  const v = normalizarHw(b(), q);
  assert.strictEqual(v.value, 100);
  assert.strictEqual(v.txId, 'hw_ORD-1001');
  assert.strictEqual(v.productCode, 'hw_off_6847681');
});

test('funil da URL; Meta so com a oferta cadastrada', () => {
  const v = normalizarHw(b(), q);
  assert.strictEqual(v.funnelSlug, 'chemistrysystem-fb1');
  assert.strictEqual(v.offerType, 'upsell');
  assert.strictEqual(v.enviarMeta, undefined);
  assert.strictEqual(v.metaSoComCadastro, true);
  assert.strictEqual(v.origem, 'hw');
});

test('sck do campo personalizado primeiro; sem ele, o da URL do checkout', () => {
  assert.strictEqual(normalizarHw(b(), q).sck, 'idx_mh5k2p_abc123def');
  assert.strictEqual(normalizarHw(b({ sck: '' }), q).sck, 'idx_outro_xyz');
  assert.strictEqual(normalizarHw(b({ sck: undefined, order_checkout_url: 'nao e url' }), q).sck, null);
});

test('utm_* vazios ficam fora; nenhum vira null', () => {
  const v = normalizarHw(b({ utm_term: '' }), q);
  assert.strictEqual(v.utms.utm_campaign, 'SWH | ABO|120230000000000001');
  assert.ok(!('utm_term' in v.utms));
  const sem = normalizarHw(b({ utm_source: '', utm_campaign: '', utm_medium: '', utm_content: '', utm_term: '' }), q);
  assert.strictEqual(sem.utms, null);
});

test('status: pago por padrao, o contrario so quando a H&W diz', () => {
  for (const s of ['PAID', 'approved', 'COMPLETED', undefined, 'algo_novo']) assert.strictEqual(traduzirStatus(s), 'paid');
  assert.strictEqual(traduzirStatus('REFUNDED'), 'refunded');
  assert.strictEqual(traduzirStatus('chargeback'), 'chargeback');
  assert.strictEqual(traduzirStatus('PENDING'), 'pending');
  assert.strictEqual(traduzirStatus('payment_failed'), 'canceled');
  assert.strictEqual(normalizarHw(b({ order_status: 'REFUNDED' }), q).paid, false);
});

test('numero do pedido numerico tambem vira txId', () => {
  assert.strictEqual(normalizarHw(b({ order_number: 12345 }), q).txId, 'hw_12345');
});

test('sem pedido: txId e status nulos; valor nao numerico vira 0', () => {
  const v = normalizarHw(b({ order_number: undefined, order_payout: 'abc' }), q);
  assert.strictEqual(v.txId, null);
  assert.strictEqual(v.status, null);
  assert.strictEqual(v.paid, false);
  assert.strictEqual(v.value, 0);
});

test('entrada vazia nao quebra', () => {
  const v = normalizarHw(undefined, undefined);
  assert.strictEqual(v.txId, null);
  assert.strictEqual(v.funnelSlug, null);
  assert.strictEqual(v.productCode, null);
});
