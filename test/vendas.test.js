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
