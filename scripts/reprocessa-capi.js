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
  // Exclui vendas de produto com send_to_meta=false (upsell/backend) — mesma
  // regra do webhook em server.js (produto nao cadastrado = envia por padrao).
  const { rows: vendas } = await pool.query(`
    SELECT s.* FROM sales s
    WHERE s.status='paid' AND s.capi_sent IS NOT TRUE AND s.funnel_id IS NOT NULL
      AND s.created_at > now() - interval '6 days'
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

    const { rows: st } = await pool.query('SELECT * FROM store WHERE sck=$1', [v.sck]);
    const store = st[0] || null;
    const sale = {
      transaction_id: v.transaction_id,
      value: v.value,
      product_code: v.product_code,
      product_name: v.product_name,
      customer_email: v.customer_email,
      customer_phone: v.customer_phone,
      event_time: v.paid_at ? Math.floor(new Date(v.paid_at).getTime() / 1000) : undefined,
    };

    if (dry) { console.log('enviaria', v.transaction_id, 'para', fs.map(f => f.pixel_id)); continue; }

    const resultados = [];
    for (const f of fs) {
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

main().catch(e => { console.error(e); process.exit(1); });
