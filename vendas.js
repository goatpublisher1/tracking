// =====================================================================
//  vendas.js — nucleo comum as plataformas de venda.
//  Recebe uma venda ja normalizada (ver payt.js / digistore24.js) e faz
//  todo o trabalho de banco e de envio a Meta.
// =====================================================================
const { sendPurchase } = require('./capi');

async function processarVenda(pool, venda) {
  const { txId, sck, src, paid, value, total } = venda;

  // ---- resolucao de funil: pixel -> sck/store -> product_code -> funil unico
  let funnel = null;
  if (venda.pixelId) {
    const r = await pool.query(
      'SELECT * FROM funnels WHERE active AND pixel_id = $1 LIMIT 1', [venda.pixelId]);
    funnel = r.rows[0] || null;
  }
  if (!funnel && sck) {
    const s = await pool.query('SELECT funnel_id FROM store WHERE sck=$1', [sck]);
    if (s.rows[0]?.funnel_id)
      funnel = (await pool.query('SELECT * FROM funnels WHERE id=$1', [s.rows[0].funnel_id])).rows[0];
  }

  // fallback: pelo product_code — resolve vendas sem sck e classifica a oferta
  let offerType = null;
  let sendToMeta = true;   // produto nao cadastrado = envia
  if (venda.productCode) {
    const pr = await pool.query(
      `SELECT pr.offer_type, pr.send_to_meta, f.* FROM products pr
       JOIN funnels f ON f.slug = pr.funnel_slug
       WHERE pr.product_code = $1 AND pr.active AND f.active LIMIT 1`, [venda.productCode]);
    if (pr.rows[0]) {
      offerType = pr.rows[0].offer_type;
      sendToMeta = pr.rows[0].send_to_meta !== false;
      if (!funnel) funnel = pr.rows[0];
    }
  }

  if (!funnel) {
    const act = await pool.query('SELECT * FROM funnels WHERE active');
    if (act.rows.length === 1) funnel = act.rows[0];
  }

  // MULTI-PIXEL: todos os funis ativos do mesmo dominio do funil achado
  let funnels = [];
  if (funnel) {
    const all = await pool.query(
      'SELECT * FROM funnels WHERE active AND domain = $1', [funnel.domain]);
    funnels = all.rows.length ? all.rows : [funnel];
  }

  // ---- dados do browser gravados no checkout
  let store = null;
  let click = null;
  if (sck) {
    const s = await pool.query('SELECT * FROM store WHERE sck=$1', [sck]);
    store = s.rows[0] || null;
    const c = await pool.query(
      'SELECT * FROM clicks WHERE sck=$1 ORDER BY created_at DESC LIMIT 1', [sck]);
    click = c.rows[0] || null;
  }

  await pool.query(
    `INSERT INTO sales (transaction_id, event_id, sck, src, status, value, total_price,
       currency, product_code, product_name, customer_email, customer_phone,
       utm_source, utm_campaign, campaign_id, adset_id, ad_id, funnel_id, offer_type,
       payment_method, paid_at, upsell_from, city, state, country, customer_ip, plataforma)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     ON CONFLICT (transaction_id) DO UPDATE SET
       status = EXCLUDED.status,
       event_id = EXCLUDED.event_id,
       -- valor: nunca deixa um 0 (webhook pre-pagamento) apagar o valor real
       value = GREATEST(COALESCE(EXCLUDED.value,0), COALESCE(sales.value,0)),
       total_price = GREATEST(COALESCE(EXCLUDED.total_price,0), COALESCE(sales.total_price,0)),
       -- atribuicao: o PRIMEIRO valor nao-nulo vence (o clique original e a verdade)
       sck = COALESCE(sales.sck, EXCLUDED.sck),
       src = COALESCE(sales.src, EXCLUDED.src),
       funnel_id = COALESCE(sales.funnel_id, EXCLUDED.funnel_id),
       utm_source = COALESCE(sales.utm_source, EXCLUDED.utm_source),
       utm_campaign = COALESCE(sales.utm_campaign, EXCLUDED.utm_campaign),
       campaign_id = COALESCE(sales.campaign_id, EXCLUDED.campaign_id),
       adset_id = COALESCE(sales.adset_id, EXCLUDED.adset_id),
       ad_id = COALESCE(sales.ad_id, EXCLUDED.ad_id),
       city = COALESCE(sales.city, EXCLUDED.city),
       state = COALESCE(sales.state, EXCLUDED.state),
       country = COALESCE(sales.country, EXCLUDED.country),
       customer_ip = COALESCE(sales.customer_ip, EXCLUDED.customer_ip),
       -- estado da transacao: o MAIS RECENTE nao-nulo vence
       customer_email = COALESCE(EXCLUDED.customer_email, sales.customer_email),
       customer_phone = COALESCE(EXCLUDED.customer_phone, sales.customer_phone),
       offer_type = COALESCE(EXCLUDED.offer_type, sales.offer_type),
       payment_method = COALESCE(EXCLUDED.payment_method, sales.payment_method),
       paid_at = COALESCE(EXCLUDED.paid_at, sales.paid_at)`,
    [txId, 'purchase_' + txId, sck, src, venda.status,
     value, total, funnel?.currency || 'BRL',
     venda.productCode, venda.productName, venda.email, venda.phone,
     click?.utm_source, click?.utm_campaign, click?.campaign_id,
     click?.adset_id, click?.ad_id, funnel ? funnel.id : null, offerType,
     venda.paymentMethod, venda.paidAt, venda.upsellFrom,
     (store?.city || venda.city || null), (store?.state || venda.state || null),
     (store?.country || venda.country || null),
     (venda.ip || store?.ip_override || null), venda.origem]
  );

  // ---- CAPI para CADA pixel ativo do dominio (multi-conta)
  // Upsell/backend ficam no banco mas nao vao para a Meta, para nao inflar
  // a otimizacao das campanhas.
  if (paid && venda.teste) {
    await pool.query(
      `UPDATE sales SET capi_response=$1 WHERE transaction_id=$2`,
      ['{"skipped":"modo_teste"}', txId]);
    return { ok: true, motivo: 'teste' };
  }

  if (paid && funnels.length && sendToMeta) {
    const sale = {
      transaction_id: txId,
      value,
      product_code: venda.productCode,
      product_name: venda.productName,
      customer_email: venda.email,
      customer_phone: venda.phone,
      customer_name: venda.nome,
    };
    const resultados = [];
    for (const f of funnels) {
      try {
        const r = await sendPurchase({ funnel: f, sale, store });
        resultados.push({ pixel: f.pixel_id, status: r.httpStatus, resp: r.response });
        await pool.query(
          `INSERT INTO event_log (event_name, event_id, source, src, funnel_id, http_status, payload)
           VALUES ('Purchase',$1,'server',$2,$3,$4,$5)`,
          ['purchase_' + txId, src, f.id, r.httpStatus, JSON.stringify(r.payload)]);
      } catch (err) {
        resultados.push({ pixel: f.pixel_id, status: 0, resp: String(err).slice(0, 200) });
      }
    }
    const algumOk = resultados.some(r => r.status === 200);
    if (!algumOk) {
      // prefixo fixo para alerta por match de string no Coolify/Discord
      console.error('CAPI_FALHOU', JSON.stringify({
        tx: txId, origem: venda.origem, funil: funnel?.slug || null, resultados,
      }));
    }
    await pool.query(
      `UPDATE sales SET capi_sent=$1, capi_response=$2 WHERE transaction_id=$3`,
      [algumOk, JSON.stringify(resultados), txId]);
    return { ok: true, motivo: null };
  }

  if (paid && !sendToMeta) {
    await pool.query(
      `UPDATE sales SET capi_response=$1 WHERE transaction_id=$2`,
      ['{"skipped":"produto_nao_envia_meta"}', txId]);
    return { ok: true, motivo: 'produto_nao_envia_meta' };
  }

  if (paid && !funnels.length) {
    await pool.query(
      `UPDATE sales SET capi_response=$1 WHERE transaction_id=$2`,
      ['{"skipped":"funnel_nao_resolvido"}', txId]);
    return { ok: true, motivo: 'funnel_nao_resolvido' };
  }

  return { ok: true, motivo: 'nao_pago' };
}

module.exports = { processarVenda };
