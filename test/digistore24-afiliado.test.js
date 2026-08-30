const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarAfiliado } = require('../digistore24-afiliado');

// Postback de exemplo, com os nomes de parametro que a nossa URL define.
function q(extra = {}) {
  return {
    funil: 'chemistrysystem-fb1',
    transactionId: '123456789',
    orderId: 'ABCD1234',
    transactionType: 'payment',
    status: 'completed',
    currency: 'USD',
    productId: '605054',
    productName: 'Main1 - FLOW (1 Jar)',
    commission: '51.00',
    amountGross: '97.00',
    country: 'US',
    dateTime: '2026-08-30T15:38:45+02:00',
    isTest: '0',
    ...extra,
  };
}

test('a comissao vira value, o bruto vira total', () => {
  const v = normalizarAfiliado(q());
  assert.strictEqual(v.value, 51);
  assert.strictEqual(v.total, 97);
});

test('txId e productCode levam o prefixo ds24a_', () => {
  const v = normalizarAfiliado(q());
  assert.strictEqual(v.txId, 'ds24a_123456789');
  assert.strictEqual(v.productCode, 'ds24a_605054');
});

test('payment vira paid', () => {
  const v = normalizarAfiliado(q());
  assert.strictEqual(v.status, 'paid');
  assert.strictEqual(v.paid, true);
});

test('refund e chargeback traduzem, e nao sao pagos', () => {
  const r = normalizarAfiliado(q({ transactionType: 'refund' }));
  assert.strictEqual(r.status, 'refunded');
  assert.strictEqual(r.paid, false);
  const c = normalizarAfiliado(q({ transactionType: 'chargeback' }));
  assert.strictEqual(c.status, 'chargeback');
  assert.strictEqual(c.paid, false);
});

test('isTest=1 marca teste, qualquer outro valor nao', () => {
  assert.strictEqual(normalizarAfiliado(q({ isTest: '1' })).teste, true);
  assert.strictEqual(normalizarAfiliado(q({ isTest: '0' })).teste, false);
  assert.strictEqual(normalizarAfiliado(q()).teste, false);
});

test('os campos que mandam no nucleo vem fixos', () => {
  const v = normalizarAfiliado(q());
  assert.strictEqual(v.funnelSlug, 'chemistrysystem-fb1');
  assert.strictEqual(v.enviarMeta, false);
  assert.strictEqual(v.offerType, 'backend');
  assert.strictEqual(v.origem, 'digistore24_afiliado');
});

test('o postback nao traz dado de comprador: fica nulo, nao inventado', () => {
  const v = normalizarAfiliado(q());
  assert.strictEqual(v.sck, null);
  assert.strictEqual(v.src, null);
  assert.strictEqual(v.email, null);
  assert.strictEqual(v.phone, null);
  assert.strictEqual(v.ip, null);
  assert.strictEqual(v.pixelId, null);
});

test('sem transactionId, txId fica null em vez de virar o prefixo sozinho', () => {
  const v = normalizarAfiliado(q({ transactionId: undefined }));
  assert.strictEqual(v.txId, null);
});

test('valor ausente ou nao numerico vira 0, nao NaN', () => {
  const v = normalizarAfiliado(q({ commission: undefined, amountGross: 'abc' }));
  assert.strictEqual(v.value, 0);
  assert.strictEqual(v.total, 0);
});

test('entrada vazia nao quebra', () => {
  const v = normalizarAfiliado({});
  assert.strictEqual(v.txId, null);
  assert.strictEqual(v.status, null);
  assert.strictEqual(v.paid, false);
});
