// =====================================================================
//  server.js — Serviço de eventos (substitui GTM + Stape)
//  Rotas:
//    POST /collect        <- página Atomicat grava dados no checkout (store)
//    POST /webhook/payt   <- webhook de venda da PayT (lookup + CAPI)
//    GET  /health
//  Multi-funil: o funil é resolvido pelo domínio de origem OU pelo slug.
// =====================================================================
const express = require('express');
const { Pool } = require('pg');
const { normalizeUtms } = require('./normalize');
const { sendPurchase } = require('./capi');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

// CORS: autoriza requisições do /collect vindas de qualquer origem.
// O /collect só grava dados de tracking (não expõe leitura), então liberar
// a origem é seguro aqui e resolve o "blocked:origin" do sendBeacon/fetch.
app.use(function (req, res, next) {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb', type: ['application/json', 'text/plain'] }));
app.use(express.text({ limit: '1mb', type: 'text/*' }));
app.use(express.urlencoded({ extended: true }));

// resolve o funil ativo por domínio (host) — usado no /collect
async function funnelByDomain(host) {
  if (!host) return null;
  const clean = host.replace(/^www\./, '');
  const { rows } = await pool.query(
    `SELECT * FROM funnels WHERE active AND (domain = $1 OR domain = $2) LIMIT 1`,
    [host, 'www.' + clean]
  );
  return rows[0] || null;
}

// resolve o funil por pixel (usado no webhook, que não traz o domínio direto)
async function funnelByPixel(pixelId) {
  const { rows } = await pool.query(
    `SELECT * FROM funnels WHERE active AND pixel_id = $1 LIMIT 1`, [pixelId]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------
//  /collect — chamado no checkout pela página. Grava no store por `src`
//  e registra o clique com UTMs normalizadas.
// ---------------------------------------------------------------------
app.post('/collect', async (req, res) => {
  try {
    // parsing robusto: sendBeacon pode chegar como objeto já parseado,
    // como string JSON, ou como Buffer. Cobrimos os três casos.
    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    else if (Buffer.isBuffer(b)) { try { b = JSON.parse(b.toString('utf8')); } catch (e) { b = {}; } }

    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
    const funnel = await funnelByDomain(host);
    if (!b.sck) {
      console.log('collect sem sck. body recebido:', JSON.stringify(req.body).slice(0, 200));
      return res.status(400).json({ error: 'missing sck' });
    }

    // grava/atualiza o store (equivale ao Stape Store Writer) — chave = sck
    await pool.query(
      `INSERT INTO store (sck, src, fbp, fbc, ip_override, user_agent, page_location,
                          external_id, city, state, country, funnel_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (sck) DO UPDATE SET
         src=EXCLUDED.src, fbp=EXCLUDED.fbp, fbc=EXCLUDED.fbc,
         ip_override=EXCLUDED.ip_override, user_agent=EXCLUDED.user_agent,
         page_location=EXCLUDED.page_location, external_id=EXCLUDED.external_id,
         city=EXCLUDED.city, state=EXCLUDED.state, country=EXCLUDED.country`,
      [b.sck, b.src, b.fbp, b.fbc, b.ip || req.ip, b.user_agent || req.headers['user-agent'],
       b.page_location, b.external_id, b.city, b.state, b.country,
       funnel ? funnel.id : null]
    );

    // registra o clique com UTMs limpas
    const u = normalizeUtms(b.utms || {});
    await pool.query(
      `INSERT INTO clicks (sck, src, fbp, fbc, fbclid, ip, user_agent, landing_url,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         campaign_id, adset_id, ad_id, placement, funnel_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [b.sck, b.src, b.fbp, b.fbc, b.fbclid, b.ip || req.ip,
       b.user_agent || req.headers['user-agent'], b.page_location,
       u.utm_source, u.utm_medium, u.utm_campaign, u.utm_content, u.utm_term,
       u.campaign_id, u.adset_id, u.ad_id, u.placement, funnel ? funnel.id : null]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('collect error', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------------------------------------------------------------------
//  /webhook/payt — recebe a venda. Só dispara Purchase em status=paid.
//  Lê o `src` do webhook, busca dados do browser no store, dispara CAPI.
// ---------------------------------------------------------------------
app.post('/webhook/payt', async (req, res) => {
  try {
    const p = req.body || {};

    // status de pagamento fica em transaction.payment_status; o de order em status
    const paid = p?.transaction?.payment_status === 'paid' || p?.status === 'paid';
    // sck = identificador único (chave do store-lookup); src = origem/UTMs
    const sck = p?.link?.sources?.sck || p?.customer?.origin?.query_params?.sck
              || p?.customer?.origin?.query_params?.click_id || null;
    const src = p?.link?.sources?.src || null;

    // valida origem pelo integration_key contra o segredo do funil (se houver)
    let funnel = null;
    if (p?.pixel_id) funnel = await funnelByPixel(p.pixel_id);
    // fallback 1: pelo sck -> store -> funnel
    if (!funnel && sck) {
      const s = await pool.query('SELECT funnel_id FROM store WHERE sck=$1', [sck]);
      if (s.rows[0]?.funnel_id)
        funnel = (await pool.query('SELECT * FROM funnels WHERE id=$1', [s.rows[0].funnel_id])).rows[0];
    }
    // fallback 2: pelo product_code (tabela products) — resolve vendas sem sck
    // e tambem classifica o tipo de oferta (principal/upsell/backend/...)
    let offerType = null;
    const prodCode = p?.product?.code;
    if (prodCode) {
      const pr = await pool.query(
        `SELECT pr.offer_type, f.* FROM products pr
         JOIN funnels f ON f.slug = pr.funnel_slug
         WHERE pr.product_code = $1 AND pr.active AND f.active LIMIT 1`, [prodCode]);
      if (pr.rows[0]) {
        offerType = pr.rows[0].offer_type;
        if (!funnel) funnel = pr.rows[0];
      }
    }

    // fallback 3: se ainda não achou e existe apenas UM funil ativo, usa ele.
    if (!funnel) {
      const act = await pool.query('SELECT * FROM funnels WHERE active');
      if (act.rows.length === 1) funnel = act.rows[0];
    }

    // MULTI-PIXEL: reúne TODOS os funis ativos do mesmo domínio do funil achado.
    // Permite ter 2+ pixels (ex.: 2 contas de anúncios) recebendo o mesmo Purchase.
    let funnels = [];
    if (funnel) {
      const all = await pool.query(
        'SELECT * FROM funnels WHERE active AND domain = $1', [funnel.domain]);
      funnels = all.rows.length ? all.rows : [funnel];
    }

    // sempre grava a venda (mesmo não-paid) para o painel/atribuição
    // value = comissão do PRODUTOR (busca por type, não índice fixo)
    const producerComm = Array.isArray(p?.commission)
      ? p.commission.find(c => c?.type === 'producer') : null;
    const value = Number(producerComm?.amount ?? p?.commission?.[0]?.amount ?? 0) / 100;
    const total = Number(p?.transaction?.total_price ?? 0) / 100; // centavos -> reais
    const txId = p?.transaction_id;

    // recupera dados do browser gravados no checkout
    let store = null;
    if (sck) {
      const s = await pool.query('SELECT * FROM store WHERE sck=$1', [sck]);
      store = s.rows[0] || null;
    }
    // pega snapshot de atribuição do clique mais recente desse src
    let click = null;
    if (sck) {
      const c = await pool.query(
        'SELECT * FROM clicks WHERE sck=$1 ORDER BY created_at DESC LIMIT 1', [sck]);
      click = c.rows[0] || null;
    }

    await pool.query(
      `INSERT INTO sales (transaction_id, event_id, sck, src, status, value, total_price,
         currency, product_code, product_name, customer_email, customer_phone,
         utm_source, utm_campaign, campaign_id, adset_id, ad_id, funnel_id, offer_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (transaction_id) DO UPDATE SET status=EXCLUDED.status,
         offer_type=COALESCE(EXCLUDED.offer_type, sales.offer_type)`,
      [txId, (sck || 'purchase_' + txId), sck, src, (p?.transaction?.payment_status || p?.status),
       value, total, funnel?.currency || 'BRL',
       p?.product?.code, p?.product?.name, p?.customer?.email, p?.customer?.phone,
       click?.utm_source, click?.utm_campaign, click?.campaign_id,
       click?.adset_id, click?.ad_id, funnel ? funnel.id : null, offerType]
    );

    // dispara CAPI para CADA pixel ativo do domínio (multi-conta)
    if (paid && funnels.length) {
      const sale = {
        transaction_id: txId,
        value,
        product_code: p?.product?.code,
        product_name: p?.product?.name,
        customer_email: p?.customer?.email,
        customer_phone: p?.customer?.phone,
        customer_name: p?.customer?.name,
      };
      const resultados = [];
      for (const f of funnels) {
        try {
          const r = await sendPurchase({ funnel: f, sale, store });
          resultados.push({ pixel: f.pixel_id, status: r.httpStatus, resp: r.response });
          await pool.query(
            `INSERT INTO event_log (event_name, event_id, source, src, funnel_id, http_status, payload)
             VALUES ('Purchase',$1,'server',$2,$3,$4,$5)`,
            [(sck || 'purchase_' + txId), src, f.id, r.httpStatus, JSON.stringify(r.payload)]
          );
        } catch (err) {
          resultados.push({ pixel: f.pixel_id, status: 0, resp: String(err).slice(0, 200) });
        }
      }
      // capi_sent = true se PELO MENOS um pixel aceitou
      const algumOk = resultados.some(r => r.status === 200);
      await pool.query(
        `UPDATE sales SET capi_sent=$1, capi_response=$2 WHERE transaction_id=$3`,
        [algumOk, JSON.stringify(resultados), txId]
      );
    } else if (paid && !funnels.length) {
      // pago mas sem funil resolvido: registra o motivo para diagnóstico
      await pool.query(
        `UPDATE sales SET capi_response=$1 WHERE transaction_id=$2`,
        ['{"skipped":"funnel_nao_resolvido"}', txId]
      );
    }

    res.json({ ok: true }); // sempre 200 rápido p/ a PayT não re-tentar à toa
  } catch (e) {
    console.error('payt webhook error', e);
    res.status(200).json({ ok: false }); // 200 mesmo em erro evita retry storm
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// registra as rotas de API do dashboard (/api/*)
const { registerApi } = require('./api');
registerApi(app, pool);

// serve o dashboard (página estática) em /dashboard
const path = require('path');
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('tracking service on :' + PORT));
