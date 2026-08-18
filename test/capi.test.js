const { test } = require('node:test');
const assert = require('node:assert');
const { hash, hashPhone, buildPurchaseEvent } = require('../capi');
const { normCidade, normEstado, normPais, normTelefone } = require('../geo');

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

test('cidade: sem acento, sem espaco, sem pontuacao', () => {
  assert.strictEqual(normCidade('São Paulo'), 'saopaulo');
  assert.strictEqual(normCidade('Rio de Janeiro'), 'riodejaneiro');
  assert.strictEqual(normCidade("Santa Bárbara d'Oeste"), 'santabarbaradoeste');
});

test('estado: sigla de 2 letras minuscula', () => {
  assert.strictEqual(normEstado('SP'), 'sp');
  assert.strictEqual(normEstado('São Paulo'), 'sp');
  assert.strictEqual(normEstado('Minas Gerais'), 'mg');
});

test('pais: ISO de 2 letras minuscula', () => {
  assert.strictEqual(normPais('BR'), 'br');
  assert.strictEqual(normPais('Brasil'), 'br');
  assert.strictEqual(normPais('Brazil'), 'br');
});

test('telefone: E.164 com codigo do pais', () => {
  assert.strictEqual(normTelefone('(11) 98888-7777'), '5511988887777');
  assert.strictEqual(normTelefone('5511988887777'), '5511988887777');
  assert.strictEqual(normTelefone('+55 11 98888-7777'), '5511988887777');
});

test('normalizacao devolve undefined para vazio', () => {
  assert.strictEqual(normCidade(''), undefined);
  assert.strictEqual(normEstado(null), undefined);
  assert.strictEqual(normTelefone(undefined), undefined);
});
