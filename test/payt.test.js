const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarPayt } = require('../payt');

// payload no formato real observado nos logs de producao
const payload = {
  transaction_id: 'T123',
  status: 'paid',
  link: { query_params: { sck: 'idx_abc123', src: 'fb1' } },
  product: { code: 'RKJZ95', name: 'Produto X' },
  customer: { email: 'a@b.com', phone: '11988887777', name: 'Ana Maria', ip: '203.0.113.9' },
  commission: [
    { type: 'affiliate', amount: 5000 },
    { type: 'producer', amount: 23615 },
  ],
  transaction: {
    payment_status: 'paid', total_price: 39700,
    payment_method: 'pix', paid_at: '2026-08-19T12:00:00Z',
  },
};

test('extrai os campos principais', () => {
  const v = normalizarPayt(payload);
  assert.strictEqual(v.origem, 'payt');
  assert.strictEqual(v.txId, 'T123');
  assert.strictEqual(v.sck, 'idx_abc123');
  assert.strictEqual(v.src, 'fb1');
  assert.strictEqual(v.productCode, 'RKJZ95');
  assert.strictEqual(v.email, 'a@b.com');
  assert.strictEqual(v.paid, true);
});

test('value e a comissao do PRODUTOR, nao a primeira da lista', () => {
  assert.strictEqual(normalizarPayt(payload).value, 236.15);
});

test('total vem de total_price convertido de centavos', () => {
  assert.strictEqual(normalizarPayt(payload).total, 397);
});

test('commission nao-array nao lanca e da value 0', () => {
  const v = normalizarPayt({ ...payload, commission: { amount: 9700 } });
  assert.strictEqual(v.value, 0);
});

test('paid aceita status no topo OU em transaction.payment_status', () => {
  assert.strictEqual(normalizarPayt({ status: 'paid' }).paid, true);
  assert.strictEqual(normalizarPayt({ transaction: { payment_status: 'paid' } }).paid, true);
  // preserva o OR original: payment_status preenchido e != paid, status == paid
  assert.strictEqual(
    normalizarPayt({ status: 'paid', transaction: { payment_status: 'refunded' } }).paid, true);
});

test('sck prioriza o prefixo idx_ sobre outros caminhos', () => {
  const v = normalizarPayt({
    sck: 'v3_outro',
    link: { query_params: { sck: 'idx_certo' } },
  });
  assert.strictEqual(v.sck, 'idx_certo');
});

test('txId cai nos fallbacks quando transaction_id falta', () => {
  assert.strictEqual(normalizarPayt({ transaction: { id: 'T9' } }).txId, 'T9');
  assert.strictEqual(normalizarPayt({ id: 'T8' }).txId, 'T8');
  assert.strictEqual(normalizarPayt({}).txId, null);
});

test('payload vazio, string ou null nao lanca', () => {
  for (const p of [null, undefined, {}, 'texto', 42, []]) {
    const v = normalizarPayt(p);
    assert.strictEqual(v.origem, 'payt');
    assert.strictEqual(v.paid, false);
  }
});

test('campos de transaction usam || como o handler original: string vazia vira null', () => {
  const v = normalizarPayt({
    transaction_id: 'T1',
    transaction: { payment_method: '', paid_at: '', upsell_from: '' },
  });
  assert.strictEqual(v.paymentMethod, null);
  assert.strictEqual(v.paidAt, null);
  assert.strictEqual(v.upsellFrom, null);
});

test('status preserva valor falsy definido, como o argumento do INSERT original', () => {
  assert.strictEqual(normalizarPayt({ status: '' }).status, '');
  assert.strictEqual(normalizarPayt({ transaction: { payment_status: '' }, status: '' }).status, '');
  // ausencia total continua caindo em undefined, nao em null
  assert.strictEqual(normalizarPayt({}).status, undefined);
});

test('value reproduz NaN do handler original para commission nao numerica', () => {
  const v = normalizarPayt({ commission: [{ type: 'producer', amount: 'abc' }] });
  assert.ok(Number.isNaN(v.value), 'esperado NaN, veio ' + v.value);
});
