const { test } = require('node:test');
const assert = require('node:assert');
const { processarVenda } = require('../vendas');

// Pool falso: sem funil resolvido e sem venda paga, o fluxo termina logo apos
// o INSERT INTO sales — o suficiente para inspecionar os parametros gravados
// sem tocar CAPI nem Postgres de verdade.
function fakePool({ storeRow = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('SELECT * FROM store WHERE sck=$1')) return { rows: storeRow ? [storeRow] : [] };
      if (text.includes('FROM clicks WHERE sck=$1')) return { rows: [] };
      // funnels/products: nunca resolve funil (mantem o teste fora do caminho de CAPI)
      return { rows: [] };
    },
  };
}

function insertSalesArgs(calls) {
  const c = calls.find(c => c.text.includes('INSERT INTO sales'));
  return c.params;
}

test('src cai para store.src quando venda.src vem null (Digistore24)', async () => {
  const pool = fakePool({ storeRow: { src: 'fb_utm_123' } });
  const venda = { txId: 'ds24_T1', sck: 'idx_abc', src: null, paid: false, value: 0, total: 0, origem: 'digistore24' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[3], 'fb_utm_123');
});

test('venda.src da propria plataforma continua vencendo (PayT nao regride)', async () => {
  const pool = fakePool({ storeRow: { src: 'store_value_ignorado' } });
  const venda = { txId: 'T2', sck: 'idx_abc', src: 'fb1', paid: false, value: 0, total: 0, origem: 'payt' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[3], 'fb1');
});

test('sem venda.src e sem store (ou sem sck), src grava null', async () => {
  const pool = fakePool();
  const venda = { txId: 'T3', sck: null, src: null, paid: false, value: 0, total: 0, origem: 'digistore24' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[3], null);
});

// Pool falso que resolve um funil (via store.funnel_id) e paga a venda, para exercitar
// o INSERT INTO event_log — que so acontece depois de um Purchase enviado com sucesso.
function fakePoolComFunil({ storeRow }) {
  const calls = [];
  const funnelRow = { id: 1, slug: 'x-fb1', domain: 'x.com', pixel_id: '123', capi_token: 'tok', currency: 'BRL', active: true };
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('SELECT funnel_id FROM store WHERE sck=$1')) return { rows: [{ funnel_id: 1 }] };
      if (text.includes('SELECT * FROM funnels WHERE id=$1')) return { rows: [funnelRow] };
      if (text.includes('SELECT * FROM funnels WHERE active AND domain')) return { rows: [funnelRow] };
      if (text.includes('SELECT * FROM store WHERE sck=$1')) return { rows: [storeRow] };
      if (text.includes('FROM clicks WHERE sck=$1')) return { rows: [] };
      return { rows: [] };
    },
  };
}

test('event_log.src usa o mesmo fallback que sales.src (Digistore24 sem venda.src)', async (t) => {
  const fetchOriginal = global.fetch;
  global.fetch = async () => ({ status: 200, json: async () => ({}) });
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePoolComFunil({ storeRow: { src: 'fb_utm_123' } });
  const venda = { txId: 'ds24_T4', sck: 'idx_abc', src: null, paid: true, value: 10, total: 10, origem: 'digistore24' };
  await processarVenda(pool, venda);

  const eventLog = pool.calls.find(c => c.text.includes('INSERT INTO event_log'));
  assert.ok(eventLog, 'event_log deveria ter sido gravado');
  assert.strictEqual(eventLog.params[1], 'fb_utm_123');
});

// Pool falso que resolve funil por SLUG, o caminho do postback de afiliado.
function fakePoolComSlug() {
  const calls = [];
  const funnelRow = { id: 7, slug: 'chemistrysystem-fb1', domain: 'www.chemistrysystem.com',
    pixel_id: '999', capi_token: 'tok', currency: 'USD', active: true };
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('WHERE active AND slug = $1')) return { rows: [funnelRow] };
      if (text.includes('SELECT * FROM funnels WHERE active AND domain')) return { rows: [funnelRow] };
      return { rows: [] };
    },
  };
}

test('funnelSlug resolve o funil sem sck e sem produto cadastrado', async () => {
  const pool = fakePoolComSlug();
  const venda = { txId: 'ds24a_1', funnelSlug: 'chemistrysystem-fb1', sck: null, src: null,
    paid: false, value: 51, total: 97, origem: 'digistore24_afiliado' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[17], 7, 'funnel_id deveria ser o do funil achado pelo slug');
  assert.strictEqual(args[7], 'USD', 'a moeda vem do funil resolvido');
});

test('enviarMeta false nao chama a Meta mesmo com venda paga e funil resolvido', async (t) => {
  const fetchOriginal = global.fetch;
  let chamou = false;
  global.fetch = async () => { chamou = true; return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePoolComSlug();
  const venda = { txId: 'ds24a_2', funnelSlug: 'chemistrysystem-fb1', sck: null, src: null,
    paid: true, value: 51, total: 97, enviarMeta: false, origem: 'digistore24_afiliado' };
  const r = await processarVenda(pool, venda);
  assert.strictEqual(chamou, false, 'a CAPI nao podia ter sido chamada');
  assert.strictEqual(r.motivo, 'produto_nao_envia_meta');
});

test('offerType da venda e gravado quando nao ha produto cadastrado', async () => {
  const pool = fakePoolComSlug();
  const venda = { txId: 'ds24a_3', funnelSlug: 'chemistrysystem-fb1', sck: null, src: null,
    paid: false, value: 51, total: 97, offerType: 'backend', origem: 'digistore24_afiliado' };
  await processarVenda(pool, venda);
  assert.strictEqual(insertSalesArgs(pool.calls)[18], 'backend');
});

test('venda sem os campos novos se comporta como antes (PayT nao regride)', async () => {
  const pool = fakePool();
  const venda = { txId: 'T10', sck: 'idx_x', src: 'fb1', paid: false, value: 100, total: 100,
    origem: 'payt' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[17], null, 'sem funil resolvido, funnel_id segue null');
  assert.strictEqual(args[18], null, 'sem produto cadastrado, offer_type segue null');
  // e nenhuma consulta por slug foi feita
  assert.ok(!pool.calls.some(c => c.text.includes('WHERE active AND slug = $1')));
});

// ---- auditoria 2026-09-11: sem fallback para pixel desativado, e teste sem CAPI

test('dominio sem funil ativo nao dispara CAPI para o funil desativado (T07)', async (t) => {
  const capi = require('../capi');
  let chamadas = 0;
  t.mock.method(capi, 'sendPurchase', async () => { chamadas++; return { httpStatus: 200, response: {}, payload: {} }; });
  const desativado = { id: 1, slug: 'velho', domain: 'x.com', pixel_id: '1', capi_token: 't', currency: 'BRL', active: false };
  const calls = [];
  const pool = { calls, async query(text, params) {
    calls.push({ text, params });
    if (text === 'SELECT funnel_id FROM store WHERE sck=$1') return { rows: [{ funnel_id: 1 }] };
    if (text === 'SELECT * FROM funnels WHERE id=$1') return { rows: [desativado] };
    if (text.includes('SELECT * FROM funnels WHERE active AND domain')) return { rows: [] };
    return { rows: [] };
  } };
  const r = await processarVenda(pool, { txId: 't7', sck: 'idx_1', paid: true, status: 'paid', value: 10 });
  assert.strictEqual(chamadas, 0);
  assert.strictEqual(r.motivo, 'funnel_nao_resolvido');
  // a venda continua gravada com o funil desativado (atribuicao)
  assert.strictEqual(insertSalesArgs(calls)[17], 1);
});

test('venda de teste grava o marcador e nunca chama a Meta, mesmo com funil e pixel ativos', async (t) => {
  const capi = require('../capi');
  let chamadas = 0;
  t.mock.method(capi, 'sendPurchase', async () => { chamadas++; return { httpStatus: 200, response: {}, payload: {} }; });
  const funnelRow = { id: 1, slug: 'f', domain: 'x.com', pixel_id: '1', capi_token: 't', currency: 'BRL', active: true };
  const calls = [];
  const pool = { calls, async query(text, params) {
    calls.push({ text, params });
    if (text.includes('WHERE active AND slug = $1')) return { rows: [funnelRow] };
    if (text.includes('SELECT * FROM funnels WHERE active AND domain')) return { rows: [funnelRow] };
    return { rows: [] };
  } };
  const r = await processarVenda(pool, { txId: 't5', funnelSlug: 'f', paid: false, teste: true, status: 'test', value: 10 });
  assert.strictEqual(chamadas, 0);
  assert.strictEqual(r.motivo, 'teste');
  assert.strictEqual(insertSalesArgs(calls)[4], 'test');
  assert.ok(calls.some(c => c.text.includes('SET capi_response') && c.params[0].includes('modo_teste')));
});

test('o upsert de sales nao deixa paid regredir para pending nem terminal voltar a paid', async () => {
  const pool = fakePool();
  await processarVenda(pool, { txId: 'tx', status: 'paid', paid: true, value: 1 });
  const sql = pool.calls.find(c => c.text.includes('INSERT INTO sales')).text;
  assert.ok(/sales\.status IN \('refunded','chargeback'\)/.test(sql));
  assert.ok(/sales\.status = 'paid' AND EXCLUDED\.status IN \('pending','waiting_payment'\)/.test(sql));
});
