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
