// =====================================================================
//  reprocessa-capi.js — reenvia vendas pagas que nao chegaram a Meta.
//  Seguro para rodar repetido: o event_id e derivado da transacao, entao
//  a Meta deduplica reenvios (ver Task 6 — NAO rode antes dela).
//  Uso: node scripts/reprocessa-capi.js [--dry]
// =====================================================================
const { Pool } = require('pg');
const { sendPurchase } = require('../capi');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const dry = process.argv.includes('--dry');

async function main() {
  // 6 dias: a Meta rejeita eventos com mais de 7 dias.
  // Duas populacoes:
  //  (a) nunca chegou a nenhuma pixel (capi_sent nao e true) — e que NAO foi pulada de
  //      proposito: teste, produto sem envio e afiliado gravam {"skipped":...} e o caminho
  //      normal decidiu nao mandar; reenviar aqui contrariaria essa decisao;
  //  (b) chegou a alguma pixel mas nao a todas (multi-conta): capi_sent=true com algum
  //      status diferente de 200 em capi_response. So as pixels que faltam recebem.
  // Exclui tambem produto com send_to_meta=false, como o webhook (nao cadastrado = envia).
  const { rows: vendas } = await pool.query(`
    SELECT s.* FROM sales s
    WHERE s.status='paid' AND s.funnel_id IS NOT NULL
      AND s.created_at > now() - interval '6 days'
      AND (
        (s.capi_sent IS NOT TRUE AND (s.capi_response IS NULL OR s.capi_response::text NOT LIKE '{"skipped"%'))
        OR (s.capi_sent IS TRUE AND s.capi_response::text ~ '"status":(?!200[,}])')
      )
      AND NOT EXISTS (
        SELECT 1 FROM products pr
        JOIN funnels f ON f.slug = pr.funnel_slug
        WHERE pr.product_code = s.product_code AND pr.active AND f.active
          AND pr.send_to_meta = false
      )
    ORDER BY s.created_at`);

  console.log(`${vendas.length} venda(s) para reprocessar${dry ? ' (dry-run)' : ''}`);

  for (const v of vendas) {
    const { rows: fs } = await pool.query(
      `SELECT f.* FROM funnels f
       JOIN funnels o ON o.domain = f.domain
       WHERE o.id = $1 AND f.active`, [v.funnel_id]);
    if (!fs.length) { console.warn('sem funil ativo', v.transaction_id); continue; }

    // Pixels que ja receberam 200 ficam de fora: a dedupe da Meta por event_id vale 48h, e
    // fora dessa janela um reenvio conta duas vezes.
    const anteriores = pixelsComSucesso(v.capi_response);
    const pendentes = fs.filter(f => !anteriores.has(String(f.pixel_id)));
    if (!pendentes.length) { console.log(v.transaction_id, 'todas as pixels ja receberam'); continue; }

    const { rows: st } = await pool.query('SELECT * FROM store WHERE sck=$1', [v.sck]);
    const store = st[0] || null;
    const sale = {
      transaction_id: v.transaction_id,
      value: v.value,
      product_code: v.product_code,
      product_name: v.product_name,
      customer_email: v.customer_email,
      customer_phone: v.customer_phone,
      // created_at, nao paid_at: o paid_at da PayT chega com hora de Brasilia rotulada como
      // UTC (3h de erro) e nao existe na Digistore24; created_at erra por segundos.
      event_time: Math.floor(new Date(v.created_at).getTime() / 1000),
    };

    if (dry) { console.log('enviaria', v.transaction_id, 'para', pendentes.map(f => f.pixel_id)); continue; }

    const resultados = resultadosAnteriores(v.capi_response).filter(r => anteriores.has(String(r.pixel)));
    for (const f of pendentes) {
      try {
        const r = await sendPurchase({ funnel: f, sale, store });
        resultados.push({ pixel: f.pixel_id, status: r.httpStatus, resp: r.response });
      } catch (err) {
        resultados.push({ pixel: f.pixel_id, status: 0, resp: String(err).slice(0, 200) });
      }
    }
    const ok = resultados.some(r => r.status === 200);
    await pool.query(
      `UPDATE sales SET capi_sent=$1, capi_response=$2 WHERE transaction_id=$3`,
      [ok, JSON.stringify(resultados), v.transaction_id]);
    console.log(v.transaction_id, ok ? 'OK' : 'FALHOU', JSON.stringify(resultados));
  }
  await pool.end();
}

// capi_response e a lista de {pixel, status, resp} que vendas.js grava; qualquer outra forma
// (null, {"skipped":...}, texto quebrado) conta como "nenhuma pixel recebeu".
function resultadosAnteriores(capiResponse) {
  try {
    const v = typeof capiResponse === 'string' ? JSON.parse(capiResponse) : capiResponse;
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function pixelsComSucesso(capiResponse) {
  return new Set(resultadosAnteriores(capiResponse).filter(r => r.status === 200).map(r => String(r.pixel)));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { pixelsComSucesso, resultadosAnteriores };
