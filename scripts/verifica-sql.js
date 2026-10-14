// =====================================================================
//  verifica-sql.js — confere, ANTES do deploy, que o SQL novo roda no banco de producao:
//  as colunas pago_em/utm_url existem em sales, e o upsert da venda e os dois backfills
//  horarios passam pelo parser e pelo planner. So SELECT e EXPLAIN (sem ANALYZE): nada e
//  executado nem gravado. Coluna faltando ou SQL quebrado no upsert = toda venda perdida.
//  Uso (de dentro do container, como scripts/q.js): node scripts/verifica-sql.js
// =====================================================================
const { SQL_UPSERT_VENDA, SQL_HERDA_FUNIL_VENDA, SQL_HERDA_FUNIL_CLIQUE } = require('../vendas');

// $1..$28 nos mesmos formatos que o vendas.js passa (texto, numero, null, JSON em texto): o
// EXPLAIN tambem confere a conversao de cada parametro para o tipo da coluna.
const PARAMS_EXEMPLO = [
  'verifica_sql', 'purchase_verifica_sql', 'idx_verifica_sql', 'FB|paid|Campanha|120000000000001', 'paid',
  97.5, 197, 'BRL', 'PROD1', 'Produto', 'a@b.com', '11999999999',
  'FB', 'Campanha', '120000000000001', '120000000000002', '120000000000003', 1, 'principal',
  'pix', '2026-10-14 12:00:00', null, 'Sao Paulo', 'SP', 'BR', '203.0.113.9', 'payt',
  '{"utm_source":"FB","utm_campaign":"Campanha|120000000000001"}',
];

async function verificaSql(pool, log = console.log) {
  let ok = true;
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'sales' AND column_name IN ('pago_em','utm_url')`);
  const faltam = ['pago_em', 'utm_url'].filter((c) => !rows.some((r) => r.column_name === c));
  if (faltam.length) {
    ok = false;
    log(`FALTA em sales: ${faltam.join(', ')} — rode o ALTER antes do deploy:`);
    log('  node scripts/q.js "ALTER TABLE sales ADD COLUMN IF NOT EXISTS pago_em TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS utm_url TEXT"');
  }
  for (const [nome, sql, params] of [
    ['upsert da venda (vendas.js)', SQL_UPSERT_VENDA, PARAMS_EXEMPLO],
    ['backfill de funil da venda (server.js)', SQL_HERDA_FUNIL_VENDA, []],
    ['backfill de funil do clique (server.js)', SQL_HERDA_FUNIL_CLIQUE, []],
  ]) {
    try {
      await pool.query('EXPLAIN ' + sql, params);
      log(`ok    ${nome}`);
    } catch (e) {
      ok = false;
      log(`ERRO  ${nome}: ${e.message}`);
    }
  }
  log(ok ? 'OK' : 'FALHOU — nao suba o tracking');
  return ok;
}

async function main() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    process.exitCode = (await verificaSql(pool)) ? 0 : 1;
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();
module.exports = { verificaSql, PARAMS_EXEMPLO };
