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

// ---- auditoria 2026-09-11
test('test:true no topo do payload grava status test e paid false', () => {
  const v = normalizarPayt({ status: 'paid', transaction_id: 'x', test: true });
  assert.strictEqual(v.status, 'test');
  assert.strictEqual(v.paid, false);
  assert.strictEqual(v.teste, true);
  assert.strictEqual(normalizarPayt({ status: 'paid', transaction_id: 'x', test: false }).paid, true);
});

test('utms: le os utm_* que a PayT recebeu na URL do checkout; sem eles, null', () => {
  const comUtm = { ...payload, link: { query_params: { sck: 'idx_abc123', src: 'fb1',
    utm_source: 'FB', utm_campaign: 'Camp|111', utm_medium: 'Conj|222', utm_content: 'Ad|333', utm_term: 'Instagram_Reels' } } };
  const v = normalizarPayt(comUtm);
  assert.deepStrictEqual(v.utms, { utm_source: 'FB', utm_campaign: 'Camp|111', utm_medium: 'Conj|222', utm_content: 'Ad|333', utm_term: 'Instagram_Reels' });
  assert.strictEqual(normalizarPayt(payload).utms, null);
});

// ---- auditoria 2026-10-14: o Purchase depende do status gravado
test('venda paga grava status paid mesmo com payment_status diferente; reembolso continua vencendo', () => {
  assert.strictEqual(normalizarPayt({ status: 'paid', transaction: { payment_status: 'approved' } }).status, 'paid');
  assert.strictEqual(normalizarPayt({ transaction: { payment_status: 'paid' }, status: 'pending' }).status, 'paid');
  // virar 'paid' esconderia o reembolso: o terminal do payment_status fica, como hoje
  assert.strictEqual(normalizarPayt({ status: 'paid', transaction: { payment_status: 'refunded' } }).status, 'refunded');
  assert.strictEqual(normalizarPayt({ status: 'paid', transaction: { payment_status: 'chargeback' } }).status, 'chargeback');
  assert.strictEqual(normalizarPayt({ status: 'paid', test: true, transaction: { payment_status: 'approved' } }).status, 'test');
  assert.strictEqual(normalizarPayt({ status: 'waiting_payment', transaction: { payment_status: 'pending' } }).status, 'pending');
});

test('statusBruto guarda o que a PayT mandou antes de virar paid (para o log de divergencia)', () => {
  const v = normalizarPayt({ ...payload, status: 'paid', transaction: { ...payload.transaction, payment_status: 'approved' } });
  assert.strictEqual(v.status, 'paid');
  assert.strictEqual(v.statusBruto, 'approved');
  assert.strictEqual(normalizarPayt(payload).statusBruto, 'paid');
});

test('paid so vence quando o payment_status tambem diz pago (paid/approved) ou nao vem; o resto fica como veio', () => {
  assert.strictEqual(normalizarPayt({ status: 'paid', transaction: { payment_status: 'approved' } }).status, 'paid');
  assert.strictEqual(normalizarPayt({ status: 'paid', transaction: { payment_status: '' } }).status, 'paid');
  assert.strictEqual(normalizarPayt({ status: 'paid' }).status, 'paid');
  for (const outro of ['canceled', 'refused', 'expired', 'refunded', 'chargeback', 'waiting_payment']) {
    const v = normalizarPayt({ status: 'paid', transaction: { payment_status: outro } });
    assert.strictEqual(v.status, outro, outro);
    assert.strictEqual(v.paid, true, 'paid continua o OR de sempre; quem barra o envio e o gate do vendas.js');
  }
});
