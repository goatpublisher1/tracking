const { test } = require('node:test');
const assert = require('node:assert');
const { hash, buildPurchaseEvent, fbcDe, buildInitiateCheckoutEvent } = require('../capi');
const { normCidade, normEstado, normPais, normTelefone } = require('../geo');

test('hash normaliza trim e lowercase antes do sha256', () => {
  assert.strictEqual(hash('  Foo@Bar.COM '), hash('foo@bar.com'));
});

test('hash devolve undefined para vazio', () => {
  assert.strictEqual(hash(''), undefined);
  assert.strictEqual(hash(null), undefined);
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

test('pais: ISO-2 minusculo a partir de sigla, nome ou ISO-3', () => {
  assert.strictEqual(normPais('BR'), 'br');
  assert.strictEqual(normPais('Brasil'), 'br');
  assert.strictEqual(normPais('US'), 'us');
  assert.strictEqual(normPais('USA'), 'us');
  assert.strictEqual(normPais('United States'), 'us');
  assert.strictEqual(normPais('Estados Unidos'), 'us');
  assert.strictEqual(normPais('United Kingdom'), 'gb');
  assert.strictEqual(normPais('UK'), 'gb');
  assert.strictEqual(normPais('Canada'), 'ca');
  assert.strictEqual(normPais('Portugal'), 'pt');
  assert.strictEqual(normPais('Australia'), 'au');
});

test('pais desconhecido fica ausente, nao inventado', () => {
  assert.strictEqual(normPais('Atlantida'), undefined);
  assert.strictEqual(normPais(''), undefined);
  assert.strictEqual(normPais(null), undefined);
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

const funnelX = { pixel_id: '123', capi_token: 'tok', currency: 'BRL' };

test('fbc: usa o cookie quando existe; senao monta do fbclid com o timestamp do clique', () => {
  assert.strictEqual(fbcDe('fb.1.1700000000000.ABC', 'XYZ', new Date(0)), 'fb.1.1700000000000.ABC');
  assert.strictEqual(fbcDe(null, 'XYZ', new Date(1700000000000)), 'fb.1.1700000000000.XYZ');
  assert.strictEqual(fbcDe('', 'XYZ', '2023-11-14T22:13:20.000Z'), 'fb.1.1700000000000.XYZ');
  assert.strictEqual(fbcDe(null, null, new Date()), undefined);
  assert.strictEqual(fbcDe(null, 'XYZ', null), undefined);
});

test('Purchase: geo cai para a venda quando o store nao tem, ja normalizado', () => {
  const ev = buildPurchaseEvent({
    funnel: funnelX,
    sale: { transaction_id: 'T1', value: 97, city: 'Sao Paulo', state: 'SP', country: 'Brasil' },
    store: {},
  });
  assert.strictEqual(ev.user_data.ct, hash('saopaulo'));
  assert.strictEqual(ev.user_data.st, hash('sp'));
  assert.strictEqual(ev.user_data.country, hash('br'));
});

test('Purchase: store vence a venda no geo, e US chega como us', () => {
  const ev = buildPurchaseEvent({
    funnel: funnelX,
    sale: { transaction_id: 'T1', value: 97, country: 'Brasil' },
    store: { country: 'United States' },
  });
  assert.strictEqual(ev.user_data.country, hash('us'));
});

test('Purchase: external_id e o hash do sck; ausente sem sck', () => {
  const com = buildPurchaseEvent({ funnel: funnelX, sale: { transaction_id: 'T1', value: 1, sck: 'idx_abc' }, store: null });
  assert.strictEqual(com.user_data.external_id, hash('idx_abc'));
  const sem = buildPurchaseEvent({ funnel: funnelX, sale: { transaction_id: 'T1', value: 1 }, store: null });
  assert.strictEqual(sem.user_data.external_id, undefined);
});

test('Purchase: fbc monta do fbclid do clique quando o store nao tem cookie', () => {
  const ev = buildPurchaseEvent({
    funnel: funnelX,
    sale: { transaction_id: 'T1', value: 1 },
    store: { fbp: 'fb.1.1.2' },
    click: { fbclid: 'CLK', created_at: new Date(1700000000000) },
  });
  assert.strictEqual(ev.user_data.fbc, 'fb.1.1700000000000.CLK');
  assert.strictEqual(ev.user_data.fbp, 'fb.1.1.2');
});

test('Purchase: ip cai para o da venda (PayT manda) quando o store nao tem', () => {
  const ev = buildPurchaseEvent({ funnel: funnelX, sale: { transaction_id: 'T1', value: 1, ip: '1.2.3.4' }, store: null });
  assert.strictEqual(ev.user_data.client_ip_address, '1.2.3.4');
});

test('Purchase sem os dados novos e identico ao de antes (nao-regressao)', () => {
  const store = { fbp: 'fb.1.1.2', fbc: 'fb.1.1.X', ip_override: '9.9.9.9', user_agent: 'UA', page_location: 'https://x/y' };
  const sale = { transaction_id: 'T1', value: 97, customer_email: 'a@b.com', customer_phone: '11999998888', customer_name: 'Ana Souza', product_code: 'P1', product_name: 'Prod' };
  const ev = buildPurchaseEvent({ funnel: funnelX, sale, store });
  assert.deepStrictEqual(Object.keys(ev.user_data).sort(),
    ['client_ip_address', 'client_user_agent', 'em', 'fbc', 'fbp', 'fn', 'ln', 'ph'].sort());
  assert.strictEqual(ev.event_id, 'purchase_T1');
  assert.strictEqual(ev.event_source_url, 'https://x/y');
  assert.strictEqual(ev.custom_data.order_id, 'T1');
});

test('IC: event_id e o sck cru, user_data so com o que o clique tem, sem custom_data', () => {
  const ev = buildInitiateCheckoutEvent({
    funnel: funnelX,
    click: { sck: 'idx_abc', fbp: 'fb.1.1.2', fbc: null, fbclid: 'CLK', ip: '1.2.3.4', user_agent: 'UA',
             landing_url: 'https://x/vsl', created_at: new Date(1700000000000) },
  });
  assert.strictEqual(ev.event_name, 'InitiateCheckout');
  assert.strictEqual(ev.event_id, 'idx_abc');
  assert.strictEqual(ev.action_source, 'website');
  assert.strictEqual(ev.event_source_url, 'https://x/vsl');
  assert.strictEqual(ev.custom_data, undefined);
  assert.deepStrictEqual(ev.user_data, {
    client_ip_address: '1.2.3.4', client_user_agent: 'UA',
    fbp: 'fb.1.1.2', fbc: 'fb.1.1700000000000.CLK', external_id: hash('idx_abc'),
  });
});

test('IC sem sck nao e construido', () => {
  assert.strictEqual(buildInitiateCheckoutEvent({ funnel: funnelX, click: { fbp: 'x' } }), null);
});
