const { test } = require('node:test');
const assert = require('node:assert');
const { verificaSql, PARAMS_EXEMPLO } = require('../scripts/verifica-sql');
const { SQL_UPSERT_VENDA } = require('../vendas');

function poolFalso({ colunas = ['pago_em', 'utm_url'], erroEm = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (erroEm && text.includes(erroEm)) throw new Error('column "pago_em" does not exist');
      if (text.includes('information_schema.columns')) return { rows: colunas.map((c) => ({ column_name: c })) };
      return { rows: [] };
    },
  };
}

test('so manda SELECT e EXPLAIN: nunca executa o INSERT nem os UPDATEs', async () => {
  const pool = poolFalso(); const linhas = [];
  const ok = await verificaSql(pool, (l) => linhas.push(l));
  assert.strictEqual(ok, true);
  assert.strictEqual(pool.calls.length, 4);
  for (const c of pool.calls) assert.ok(/^\s*(SELECT|EXPLAIN)\s/.test(c.text), 'consulta proibida: ' + c.text.slice(0, 60));
  assert.ok(pool.calls.some((c) => c.text === 'EXPLAIN ' + SQL_UPSERT_VENDA && c.params === PARAMS_EXEMPLO));
  assert.strictEqual(linhas.at(-1), 'OK');
});

test('os parametros de exemplo cobrem todos os $n do upsert', () => {
  const maior = Math.max(...[...SQL_UPSERT_VENDA.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.strictEqual(PARAMS_EXEMPLO.length, maior);
});

test('coluna faltando manda rodar o ALTER antes do deploy; erro do Postgres aparece e falha', async () => {
  const linhas = [];
  const ok = await verificaSql(poolFalso({ colunas: ['utm_url'], erroEm: 'INSERT INTO sales' }), (l) => linhas.push(l));
  assert.strictEqual(ok, false);
  assert.ok(linhas.some((l) => l.includes('pago_em') && l.includes('rode o ALTER antes do deploy')));
  assert.ok(linhas.some((l) => l.startsWith('ERRO') && l.includes('does not exist')));
  assert.ok(!linhas.includes('OK'));
});
