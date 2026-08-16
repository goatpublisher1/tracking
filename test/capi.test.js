const { test } = require('node:test');
const assert = require('node:assert');
const { hash, hashPhone, buildPurchaseEvent } = require('../capi');

test('hash normaliza trim e lowercase antes do sha256', () => {
  assert.strictEqual(hash('  Foo@Bar.COM '), hash('foo@bar.com'));
});

test('hash devolve undefined para vazio', () => {
  assert.strictEqual(hash(''), undefined);
  assert.strictEqual(hash(null), undefined);
});

test('hashPhone remove nao-digitos', () => {
  assert.strictEqual(hashPhone('(11) 98888-7777'), hash('11988887777'));
});

const funnelFake = { pixel_id: '123', capi_token: 'tok', currency: 'BRL' };

test('event_id deriva da transacao, nao do sck', () => {
  const ev = buildPurchaseEvent({
    funnel: funnelFake,
    sale: { transaction_id: 'T1', value: 97, customer_email: 'a@b.com' },
    store: { sck: 'idx_abc' },
  });
  assert.strictEqual(ev.event_id, 'purchase_T1');
});

test('duas transacoes do mesmo sck geram event_id diferentes', () => {
  const store = { sck: 'idx_abc' };
  const a = buildPurchaseEvent({ funnel: funnelFake, sale: { transaction_id: 'T1', value: 97 }, store });
  const b = buildPurchaseEvent({ funnel: funnelFake, sale: { transaction_id: 'T2', value: 47 }, store });
  assert.notStrictEqual(a.event_id, b.event_id);
});

test('mesma transacao gera sempre o mesmo event_id (reenvio idempotente)', () => {
  const s = { transaction_id: 'T9', value: 10 };
  const a = buildPurchaseEvent({ funnel: funnelFake, sale: s, store: null });
  const b = buildPurchaseEvent({ funnel: funnelFake, sale: s, store: null });
  assert.strictEqual(a.event_id, b.event_id);
});
