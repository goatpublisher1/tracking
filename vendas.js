// =====================================================================
//  vendas.js — nucleo comum as plataformas de venda.
//  Recebe uma venda ja normalizada (ver payt.js / digistore24.js) e faz
//  todo o trabalho de banco e de envio a Meta.
// =====================================================================
const { sendPurchase, temPixel } = require('./capi');
const { sendCompletePayment } = require('./tiktok');
const { normalizeUtms, idNumerico } = require('./normalize');

// Id de campanha/conjunto/anuncio limpo (numerico ou null). String(): o que vem do banco pode nao
// ser texto, e nada no caminho do webhook pode lancar antes do INSERT.
const idLimpo = (v) => (v == null ? null : idNumerico(String(v)));

// Upsert da venda. Constante exportada para o scripts/verifica-sql.js conferir o texto com EXPLAIN
// no banco de producao antes do deploy, sem gravar nada (coluna faltando = toda venda perdida).
const SQL_UPSERT_VENDA = `INSERT INTO sales (transaction_id, event_id, sck, src, status, value, total_price,
     currency, product_code, product_name, customer_email, customer_phone,
     utm_source, utm_campaign, campaign_id, adset_id, ad_id, funnel_id, offer_type,
     payment_method, paid_at, upsell_from, city, state, country, customer_ip, plataforma,
     refunded_at, pago_em, utm_url)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
     CASE WHEN $5 IN ('refunded','chargeback') THEN now() END,
     CASE WHEN $5 = 'paid' THEN now() END, $28)
   ON CONFLICT (transaction_id) DO UPDATE SET
     -- status so anda para frente, por posto: 0 = qualquer nao pago, 1 = paid,
     -- 2 = refunded/chargeback. Webhook atrasado ou reapresentado nao desfaz pagamento nem
     -- reembolso (paid -> canceled/expired tambem passava); no mesmo posto vale o mais novo.
     -- 'test' nunca sobrescreve status real.
     status = CASE
       WHEN EXCLUDED.status = 'test' THEN COALESCE(sales.status, EXCLUDED.status)
       WHEN (CASE WHEN EXCLUDED.status = 'paid' THEN 1 WHEN EXCLUDED.status IN ('refunded','chargeback') THEN 2 ELSE 0 END)
          < (CASE WHEN sales.status = 'paid' THEN 1 WHEN sales.status IN ('refunded','chargeback') THEN 2 ELSE 0 END)
         THEN sales.status
       ELSE EXCLUDED.status END,
     event_id = EXCLUDED.event_id,
     -- valor: nunca deixa um 0 (webhook pre-pagamento) apagar o valor real
     value = GREATEST(COALESCE(EXCLUDED.value,0), COALESCE(sales.value,0)),
     total_price = GREATEST(COALESCE(EXCLUDED.total_price,0), COALESCE(sales.total_price,0)),
     -- atribuicao: o PRIMEIRO valor nao-nulo vence (o clique original e a verdade)
     sck = COALESCE(sales.sck, EXCLUDED.sck),
     src = COALESCE(sales.src, EXCLUDED.src),
     funnel_id = COALESCE(sales.funnel_id, EXCLUDED.funnel_id),
     -- as cinco colunas da campanha andam juntas: venda gravada sem campanha (webhook pendente
     -- antes do clique casar, upsell antes da mae) ganha as cinco do webhook seguinte que tiver
     -- campanha. Com COALESCE coluna a coluna, a utm_source do clique sem campanha ficava ao
     -- lado do campaign_id do outro. Venda com campanha A nunca recebe o conjunto/anuncio de
     -- outra campanha (nem de fonte sem campanha); da mesma campanha, completa o que faltava.
     -- Campanha gravada nao numerica ('Teste', '{campaignid}' de antes do normalize.js novo) conta
     -- como ausente: a primeira campanha de verdade substitui as cinco.
     utm_source = CASE
       WHEN sales.campaign_id ~ '^\\d{5,}$' AND sales.campaign_id IS DISTINCT FROM EXCLUDED.campaign_id THEN sales.utm_source
       WHEN (sales.campaign_id ~ '^\\d{5,}$') IS NOT TRUE AND EXCLUDED.campaign_id IS NOT NULL THEN EXCLUDED.utm_source
       ELSE COALESCE(sales.utm_source, EXCLUDED.utm_source) END,
     utm_campaign = CASE
       WHEN sales.campaign_id ~ '^\\d{5,}$' AND sales.campaign_id IS DISTINCT FROM EXCLUDED.campaign_id THEN sales.utm_campaign
       WHEN (sales.campaign_id ~ '^\\d{5,}$') IS NOT TRUE AND EXCLUDED.campaign_id IS NOT NULL THEN EXCLUDED.utm_campaign
       ELSE COALESCE(sales.utm_campaign, EXCLUDED.utm_campaign) END,
     campaign_id = CASE
       WHEN sales.campaign_id ~ '^\\d{5,}$' AND sales.campaign_id IS DISTINCT FROM EXCLUDED.campaign_id THEN sales.campaign_id
       WHEN (sales.campaign_id ~ '^\\d{5,}$') IS NOT TRUE AND EXCLUDED.campaign_id IS NOT NULL THEN EXCLUDED.campaign_id
       ELSE COALESCE(sales.campaign_id, EXCLUDED.campaign_id) END,
     adset_id = CASE
       WHEN sales.campaign_id ~ '^\\d{5,}$' AND sales.campaign_id IS DISTINCT FROM EXCLUDED.campaign_id THEN sales.adset_id
       WHEN (sales.campaign_id ~ '^\\d{5,}$') IS NOT TRUE AND EXCLUDED.campaign_id IS NOT NULL THEN EXCLUDED.adset_id
       ELSE COALESCE(sales.adset_id, EXCLUDED.adset_id) END,
     ad_id = CASE
       WHEN sales.campaign_id ~ '^\\d{5,}$' AND sales.campaign_id IS DISTINCT FROM EXCLUDED.campaign_id THEN sales.ad_id
       WHEN (sales.campaign_id ~ '^\\d{5,}$') IS NOT TRUE AND EXCLUDED.campaign_id IS NOT NULL THEN EXCLUDED.ad_id
       ELSE COALESCE(sales.ad_id, EXCLUDED.ad_id) END,
     utm_url = COALESCE(sales.utm_url, EXCLUDED.utm_url),
     city = COALESCE(sales.city, EXCLUDED.city),
     state = COALESCE(sales.state, EXCLUDED.state),
     country = COALESCE(sales.country, EXCLUDED.country),
     customer_ip = COALESCE(sales.customer_ip, EXCLUDED.customer_ip),
     -- estado da transacao: o MAIS RECENTE nao-nulo vence
     customer_email = COALESCE(EXCLUDED.customer_email, sales.customer_email),
     customer_phone = COALESCE(EXCLUDED.customer_phone, sales.customer_phone),
     offer_type = COALESCE(EXCLUDED.offer_type, sales.offer_type),
     payment_method = COALESCE(EXCLUDED.payment_method, sales.payment_method),
     paid_at = COALESCE(EXCLUDED.paid_at, sales.paid_at),
     -- a hora em que a venda virou reembolso/chargeback: so na primeira vez, e nunca apagada
     refunded_at = CASE
       WHEN sales.refunded_at IS NULL AND EXCLUDED.status IN ('refunded','chargeback') THEN now()
       ELSE sales.refunded_at END,
     -- pago_em: hora do servidor em que a venda virou paid (o paid_at da PayT vem 3h adiantado e
     -- a Digistore24 nao manda). So na transicao: venda que ja estava paid antes desta coluna
     -- existir fica nula (o dashboard cai no created_at), em vez de ganhar a hora de um reenvio
     -- dias depois; e paid atrasado sobre reembolso nao conta.
     pago_em = CASE
       WHEN sales.pago_em IS NULL AND EXCLUDED.status = 'paid'
         AND COALESCE(sales.status, '') NOT IN ('paid','refunded','chargeback') THEN now()
       ELSE sales.pago_em END
   RETURNING status`;

// Backfills horarios do server.js (moram aqui pelo mesmo motivo: o verifica-sql.js le daqui).
// Venda sem funil (sem sck e produto ainda nao cadastrado na hora — tipico de recuperacao) ganha
// o funil do produto. So preenche vazio: funil ja resolvido pelo sck nao muda. Sem exigir
// f.active (produto continua no funil antigo depois da troca de dominio, como no webhook), mas o
// ativo vem primeiro; DISTINCT ON deixa um funil por produto, f.id desempata sempre igual.
const SQL_HERDA_FUNIL_VENDA = `UPDATE sales s SET funnel_id = pf.funnel_id
     FROM (SELECT DISTINCT ON (p.product_code) p.product_code, f.id AS funnel_id
             FROM products p JOIN funnels f ON f.slug = p.funnel_slug
            WHERE p.active
            ORDER BY p.product_code, f.active DESC NULLS LAST, f.id) pf
    WHERE pf.product_code = s.product_code AND s.funnel_id IS NULL`;

// Clique gravado sem funil (/collect chamado por um host que nao casou com o cadastro) nao
// aparece em nenhum funil do dashboard. O dominio da pagina (landing_url) diz qual era: host em
// minusculas, sem track. nem www., como em funnelByDomain. 7 dias: o que ficou para tras disso
// nao e mais de campanha em andamento. Varios funis ativos no dominio: o de menor id.
const SQL_HERDA_FUNIL_CLIQUE = `UPDATE clicks c SET funnel_id = fd.id
     FROM (SELECT DISTINCT ON (dominio) id, dominio
             FROM (SELECT id, regexp_replace(lower(domain), '^(track\\.)?(www\\.)?', '') AS dominio
                     FROM funnels WHERE active AND domain IS NOT NULL) a
            ORDER BY dominio, id) fd
    WHERE c.funnel_id IS NULL AND c.created_at > now() - interval '7 days'
      AND fd.dominio = regexp_replace(substring(lower(c.landing_url) from '^[a-z][a-z0-9+.-]*://([^/:?#]+)'), '^(track\\.)?(www\\.)?', '')`;

// Venda gravada ANTES de o produto ser cadastrado ficou com offer_type nulo (ou o que a
// plataforma mandou). O cadastro do produto e a fonte da verdade — no webhook ele ja sobrescreve
// o tipo —, entao as vendas antigas herdam o tipo tambem; e o funil, como nos dois SQL acima.
// Um try por UPDATE, cada um com o seu log: a falha de um nao pula os outros, e o log diz qual.
async function herdarDoProduto(pool) {
  const passos = [
    ['OFFER_TYPE_HERDADO', `UPDATE sales s SET offer_type = p.offer_type
         FROM products p
        WHERE p.product_code = s.product_code AND p.active
          AND s.offer_type IS DISTINCT FROM p.offer_type`],
    ['FUNNEL_ID_HERDADO', SQL_HERDA_FUNIL_VENDA],
    ['FUNNEL_CLIQUE_HERDADO', SQL_HERDA_FUNIL_CLIQUE],
  ];
  for (const [rotulo, sql] of passos) {
    try {
      const r = await pool.query(sql);
      if (r.rowCount) console.log(rotulo, r.rowCount);
    } catch (err) { console.error(rotulo + '_ERRO', err); }
  }
}

async function processarVenda(pool, venda) {
  const { txId, sck, paid, value, total } = venda;

  // ---- venda-mae: upsell e order bump chegam sem sck e sem utm (a plataforma cobra sem passar
  // pelo checkout de novo) e caiam em "Sem origem". A mae e quem passou pelo clique: na PayT o
  // upsell traz o transaction_id dela em upsell_from; na Digistore24 todas as vendas do pedido
  // trazem o mesmo order_id em upsell_from. Prefere a irma com campanha (id numerico: 'Teste' e
  // '{campaignid}' gravados antes nao contam), depois a mais antiga.
  // try: nada aqui pode impedir o INSERT da venda.
  let mae = null;
  if (venda.upsellFrom) {
    try {
      const m = await pool.query(
        `SELECT sck, utm_source, utm_campaign, campaign_id, adset_id, ad_id, funnel_id FROM sales
          WHERE transaction_id <> $1 AND (transaction_id = $2 OR upsell_from = $2)
          ORDER BY (campaign_id ~ '^\\d{5,}$') IS TRUE DESC, created_at ASC LIMIT 1`, [txId, venda.upsellFrom]);
      mae = m.rows[0] || null;
    } catch (e) {
      console.warn('VENDA_MAE_FALHOU', JSON.stringify({ tx: txId, erro: String(e).slice(0, 120) }));
    }
  }
  // O sck da mae vale para tudo que vem do navegador (store, clique, external_id da CAPI) e e o
  // que fica gravado: o upsell passa a ser da mesma pessoa e do mesmo clique.
  const sckEfetivo = sck || mae?.sck || null;

  // ---- resolucao de funil: pixel -> sck/store -> venda-mae -> product_code -> funil unico
  let funnel = null;
  // Postback de afiliado: a conexao S2S e dedicada a uma parceria, entao o
  // funil vem fixo na URL. Sem sck e sem produto cadastrado, nada abaixo
  // resolveria, e venda com funnel_id nulo e invisivel no dashboard.
  if (venda.funnelSlug) {
    const r = await pool.query(
      'SELECT * FROM funnels WHERE active AND slug = $1 LIMIT 1', [venda.funnelSlug]);
    funnel = r.rows[0] || null;
  }
  if (!funnel && venda.pixelId) {
    const r = await pool.query(
      'SELECT * FROM funnels WHERE active AND pixel_id = $1 LIMIT 1', [venda.pixelId]);
    funnel = r.rows[0] || null;
  }
  if (!funnel && sckEfetivo) {
    const s = await pool.query('SELECT funnel_id FROM store WHERE sck=$1', [sckEfetivo]);
    if (s.rows[0]?.funnel_id)
      funnel = (await pool.query('SELECT * FROM funnels WHERE id=$1', [s.rows[0].funnel_id])).rows[0];
  }
  // Upsell sem store: o funil e o da mae, antes do fallback por produto (o produto do upsell pode
  // estar cadastrado em outro funil, ou em nenhum).
  if (!funnel && mae?.funnel_id) {
    try {
      funnel = (await pool.query('SELECT * FROM funnels WHERE id=$1', [mae.funnel_id])).rows[0] || null;
    } catch (e) {
      console.warn('VENDA_MAE_FALHOU', JSON.stringify({ tx: txId, etapa: 'funil', erro: String(e).slice(0, 120) }));
    }
  }

  // fallback: pelo product_code — resolve vendas sem sck e classifica a oferta
  // O produto cadastrado, quando existe, sobrescreve os dois logo abaixo.
  // offerType inicial importa para a venda de afiliado: sem ele o offer_type
  // grava null, e a query de receita do dashboard usa `= 'principal'` e
  // `<> 'principal'` — com null nenhuma das duas e verdadeira, e a venda some
  // das duas quebras.
  let offerType = venda.offerType || null;
  let sendToMeta = true;   // produto nao cadastrado = envia
  // TikTok: produto NAO cadastrado nao vai (o upload nao se desfaz; omissao e o
  // lado seguro). Cadastrado, segue send_to_tiktok.
  let sendToTikTok = false;
  let produtoCadastrado = false;
  if (venda.productCode) {
    // Sem `AND f.active`: quando o dominio troca, o funil antigo e desativado mas o produto continua
    // cadastrado nele — e eram o offer_type e o send_to_* dele que sumiam (o upsell perdia o tipo e
    // ia para a Meta). O ativo, se houver, vem primeiro; f.id desempata sempre igual.
    const pr = await pool.query(
      `SELECT pr.offer_type, pr.send_to_meta, pr.send_to_tiktok, f.* FROM products pr
       JOIN funnels f ON f.slug = pr.funnel_slug
       WHERE pr.product_code = $1 AND pr.active
       ORDER BY f.active DESC NULLS LAST, f.id LIMIT 1`, [venda.productCode]);
    if (pr.rows[0]) {
      produtoCadastrado = true;
      offerType = pr.rows[0].offer_type;
      sendToMeta = pr.rows[0].send_to_meta !== false;
      sendToTikTok = pr.rows[0].send_to_tiktok === true;
      if (!funnel) funnel = pr.rows[0];
    }
  }
  // "Nao cadastrado = envia" vale para a venda principal. Upsell/order bump nao cadastrado (achou
  // a mae e nao tem sck proprio) nao vai para a Meta: sem cadastro nao ha send_to_meta para
  // respeitar, e herdar o sck da mae nao pode fazer a venda filha inflar a otimizacao. O `!sck`
  // importa na Digistore24: toda venda traz o order_id em upsell_from, entao a principal tambem
  // acha "mae" (uma irma) — mas chega com o sck dela. TikTok ja fica fora (nao cadastrado).
  if (!produtoCadastrado && mae && !sck) sendToMeta = false;

  // Terminal, e por isso vem depois do bloco acima: comissao de produto de
  // terceiro nao vai para a Meta nem se alguem cadastrar esse produto com
  // send_to_meta = true. Inflaria a otimizacao das nossas campanhas.
  if (venda.enviarMeta === false) { sendToMeta = false; sendToTikTok = false; }

  if (!funnel) {
    const act = await pool.query('SELECT * FROM funnels WHERE active');
    if (act.rows.length === 1) funnel = act.rows[0];
  }

  // MULTI-PIXEL: todos os funis ativos do mesmo dominio do funil achado. Sem fallback para
  // `[funnel]`: quando o dominio nao tem mais nenhum funil ativo, o funil resolvido pelo
  // store/produto e um desativado — a venda continua gravada com o funnel_id dele (atribuicao
  // no dashboard), mas pixel desligado nao recebe CAPI.
  // Registro ativo SEM pixel (funil so Google/TikTok, ou pixel ainda nao cadastrado) tambem
  // fica de fora da CAPI — mas e um caso distinto de "sem funil ativo": a venda e normal.
  let funnels = [];
  let ativosSemPixel = false;
  if (funnel) {
    const all = await pool.query(
      'SELECT * FROM funnels WHERE active AND domain = $1', [funnel.domain]);
    funnels = (all.rows || []).filter(temPixel);
    ativosSemPixel = (all.rows || []).length > 0 && funnels.length === 0;
  }

  // Como a venda estava ANTES deste webhook. PayT e Digistore24 reapresentam o mesmo webhook, e
  // cada reenvio virava outro Purchase (a dedupe da Meta por event_id so cobre 48h). created_at
  // e a hora da venda, que limita o clique com campanha abaixo num reenvio dias depois.
  // try: se a leitura falhar, a venda segue como hoje (envia).
  let antes = null;
  try {
    antes = (await pool.query('SELECT status, capi_sent, created_at FROM sales WHERE transaction_id=$1', [txId])).rows[0] || null;
  } catch (e) {
    console.warn('VENDA_ANTES_FALHOU', JSON.stringify({ tx: txId, erro: String(e).slice(0, 120) }));
  }

  // ---- dados do browser gravados no checkout
  let store = null;
  let click = null;
  let cliqueComCampanha = null;
  if (sckEfetivo) {
    const s = await pool.query('SELECT * FROM store WHERE sck=$1', [sckEfetivo]);
    store = s.rows[0] || null;
    const c = await pool.query(
      'SELECT * FROM clicks WHERE sck=$1 ORDER BY created_at DESC LIMIT 1', [sckEfetivo]);
    click = c.rows[0] || null;
    // O clique mais recente continua sendo o do navegador na CAPI, mas nao o da atribuicao: pode
    // ser uma volta sem anuncio (aba reaberta, link da bio) depois do clique pago, ou — num reenvio
    // do webhook dias depois — um clique de outra campanha DEPOIS da venda. Para a atribuicao vale
    // sempre o ultimo clique com campanha (id numerico) ate a hora da venda (venda nova: agora).
    if (click) {
      try {
        const cc = await pool.query(
          `SELECT * FROM clicks WHERE sck=$1 AND campaign_id ~ '^\\d{5,}$'
              AND created_at <= COALESCE($2::timestamptz, now())
            ORDER BY created_at DESC LIMIT 1`, [sckEfetivo, antes?.created_at ?? null]);
        cliqueComCampanha = cc.rows[0] || null;
      } catch (e) {
        console.warn('CLIQUE_COM_CAMPANHA_FALHOU', JSON.stringify({ tx: txId, erro: String(e).slice(0, 120) }));
      }
    }
  }
  // Reserva da atribuicao (sem campanha em lugar nenhum): o clique mais recente, so se for de
  // antes da venda gravada.
  const cliqueAteVenda = click && (!antes?.created_at || new Date(click.created_at) <= new Date(antes.created_at))
    ? click : null;

  // O IPN da Digistore24 nao tem campo de src (sid1 e do postback de afiliado),
  // entao venda.src vem null nessa plataforma. O /collect ja gravou store.src a
  // partir das UTMs da pagina — usar como fallback faz as duas plataformas
  // gravarem o mesmo conjunto de campos. Nao afeta atribuicao: campaign_id,
  // adset_id e ad_id vem da tabela clicks e ja chegam preenchidos.
  // Mesmo fallback vale para event_log.src abaixo — os dois tem que concordar.
  const srcFinal = venda.src || store?.src || null;

  // Atribuicao, nesta ordem: (1) utm_* da URL do proprio checkout com campanha — e o anuncio que
  // trouxe ESTA compra, enquanto o clique do mesmo sck pode ser de dias antes, de outra campanha
  // (so a PayT manda; a Digistore24 nao tem utm no IPN); (2) ultimo clique do sck com campanha,
  // ate a venda; (3) venda-mae com campanha (upsell); (4) ultimo clique ate a venda; (5) utm_* da
  // URL sem campanha. "Com campanha" = id numerico em todo lugar: 'Teste' e '{campaignid}'
  // gravados antes do normalize.js novo nao contam, e os tres ids saem limpos (nao numerico vira
  // null, ::fbclid colado sai), como o normalize.js faz no clique.
  // try: decodeURIComponent lanca com "%" solto, e nada aqui pode impedir o INSERT da venda.
  let daUrl = null;
  try {
    daUrl = venda.utms ? normalizeUtms(venda.utms) : null;
  } catch (e) {
    console.warn('UTM_DA_URL_INVALIDA', JSON.stringify({ tx: txId, erro: String(e).slice(0, 120) }));
  }
  const comCampanha = (x) => (x && idLimpo(x.campaign_id) ? x : null);
  const atrib = comCampanha(daUrl) || comCampanha(cliqueComCampanha) || comCampanha(mae)
    || cliqueAteVenda || daUrl || null;

  const retorno = await pool.query(SQL_UPSERT_VENDA,
    [txId, 'purchase_' + txId, sckEfetivo, srcFinal, venda.status,
     value, total, funnel?.currency || 'BRL',
     venda.productCode, venda.productName, venda.email, venda.phone,
     atrib?.utm_source, atrib?.utm_campaign, idLimpo(atrib?.campaign_id),
     idLimpo(atrib?.adset_id), idLimpo(atrib?.ad_id), funnel ? funnel.id : null, offerType,
     venda.paymentMethod, venda.paidAt, venda.upsellFrom,
     (store?.city || venda.city || null), (store?.state || venda.state || null),
     (store?.country || venda.country || null),
     (venda.ip || store?.ip_override || null), venda.origem,
     // utm_url: os utm_* crus que o checkout recebeu, para conferir/reatribuir depois
     venda.utms ? JSON.stringify(venda.utms).slice(0, 2000) : null]
  );
  // O status que ficou gravado decide os envios abaixo: um 'paid' atrasado depois do reembolso
  // grava 'refunded' e nao pode virar Purchase. `?? venda.status`: pool sem RETURNING (testes).
  const statusFinal = retorno?.rows?.[0]?.status ?? venda.status;
  // Sinais greppaveis: plataforma dizendo "pago" com outro status (o Purchase depende do status
  // gravado), e upsert que manteve o status antigo (paid atrasado sobre reembolso, etc.).
  // Pago com o status bruto da plataforma diferente de 'paid' ('approved', 'refunded' com
  // status=paid...): o payt.js ja decidiu o que gravar; o log mostra quando isso acontece.
  if (paid && venda.statusBruto && venda.statusBruto !== 'paid') {
    console.warn('PAID_STATUS_DIVERGENTE', JSON.stringify({ tx: txId, origem: venda.origem, status: venda.statusBruto, gravado: statusFinal ?? null }));
  }
  if (statusFinal !== venda.status && venda.status !== 'test') {
    console.warn('STATUS_MANTIDO', JSON.stringify({ tx: txId, recebido: venda.status ?? null, ficou: statusFinal ?? null }));
  }

  // ---- CAPI para CADA pixel ativo do dominio (multi-conta)
  // Upsell/backend ficam no banco mas nao vao para a Meta, para nao inflar
  // a otimizacao das campanhas.
  // Teste ja chega com status 'test' e paid=false dos normalizadores; o marcador em
  // capi_response continua para o reprocesso e para quem for reconciliar.
  if (venda.teste) {
    await pool.query(
      `UPDATE sales SET capi_response=$1 WHERE transaction_id=$2`,
      ['{"skipped":"modo_teste"}', txId]);
    return { ok: true, motivo: 'teste' };
  }

  // Fora do bloco da Meta: a TikTok usa o mesmo objeto (a Meta ignora o campo currency).
  const sale = {
    transaction_id: txId,
    value,
    product_code: venda.productCode,
    product_name: venda.productName,
    customer_email: venda.email,
    customer_phone: venda.phone,
    customer_name: venda.nome,
    // Para o user_data da CAPI: sck vira external_id; geo e ip sao fallback
    // quando o store nao tem (o header nunca mandou geo; PayT manda ip,
    // Digistore24 manda geo). O sck efetivo e o gravado: o reprocesso manda o mesmo.
    sck: sckEfetivo,
    city: venda.city, state: venda.state, country: venda.country,
    ip: venda.ip,
    currency: funnel?.currency || 'BRL',
  };

  let motivoMeta = null;
  // Purchase so na transicao para paid, ou com paid gravado e capi_sent nao verdadeiro (a
  // primeira tentativa falhou e o reenvio do webhook e a segunda chance). capi_response fica
  // como estava nos dois pulos abaixo: e o registro do envio que valeu.
  // ja_enviada olha so o capi_sent: linha antiga que foi paid -> canceled (antes da regra de
  // posto) com o Purchase ja enviado nao reenvia quando volta um paid.
  if (paid && statusFinal !== 'paid') {
    motivoMeta = 'status_' + statusFinal;
  } else if (paid && antes?.capi_sent === true) {
    motivoMeta = 'ja_enviada';
  } else if (paid && funnels.length && sendToMeta) {
    const resultados = [];
    for (const f of funnels) {
      try {
        const r = await sendPurchase({ funnel: f, sale, store, click });
        resultados.push({ pixel: f.pixel_id, status: r.httpStatus, resp: r.response });
        await pool.query(
          `INSERT INTO event_log (event_name, event_id, source, src, funnel_id, http_status, payload, plataforma)
           VALUES ('Purchase',$1,'server',$2,$3,$4,$5,'meta')`,
          ['purchase_' + txId, srcFinal, f.id, r.httpStatus, JSON.stringify(r.payload)]);
      } catch (err) {
        resultados.push({ pixel: f.pixel_id, status: 0, resp: String(err).slice(0, 200) });
        // Falha (timeout/rede) tambem entra no event_log com status 0, como o IC, para a
        // aba Meta do dashboard nao contar Purchase que falhou como aceito.
        try {
          await pool.query(
            `INSERT INTO event_log (event_name, event_id, source, src, funnel_id, http_status, payload, plataforma)
             VALUES ('Purchase',$1,'server',$2,$3,$4,$5,'meta')`,
            ['purchase_' + txId, srcFinal, f.id, 0, null]);
        } catch (e2) { /* erro de banco aqui nao pode mascarar a falha original */ }
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
    motivoMeta = null;
  } else if (paid && !sendToMeta) {
    await pool.query(
      `UPDATE sales SET capi_response=$1 WHERE transaction_id=$2`,
      ['{"skipped":"produto_nao_envia_meta"}', txId]);
    motivoMeta = 'produto_nao_envia_meta';
  } else if (paid && ativosSemPixel) {
    // prefixo fixo, greppavel: venda paga que nao foi a Meta por falta de pixel no dominio.
    console.error('CAPI_SEM_PIXEL', JSON.stringify({ tx: txId, funil: funnel?.slug || null, dominio: funnel?.domain || null }));
    await pool.query(
      `UPDATE sales SET capi_response=$1 WHERE transaction_id=$2`,
      ['{"skipped":"sem_pixel"}', txId]);
    motivoMeta = 'sem_pixel';
  } else if (paid && !funnels.length) {
    await pool.query(
      `UPDATE sales SET capi_response=$1 WHERE transaction_id=$2`,
      ['{"skipped":"funnel_nao_resolvido"}', txId]);
    motivoMeta = 'funnel_nao_resolvido';
  } else {
    motivoMeta = 'nao_pago';
  }

  // ---- TikTok: depois da Meta, nunca no caminho dela. Um CompletePayment por
  // pixel TikTok ativo do dominio; falha vira log e linha no event_log (status 0).
  // Sem capi_sent do lado da TikTok: so na transicao para paid, nunca no reenvio do webhook.
  // capi_sent verdadeiro = a venda ja passou por paid antes (e o CompletePayment teve a vez dele).
  if (paid && statusFinal === 'paid' && antes?.status !== 'paid' && antes?.capi_sent !== true
      && funnel && sendToTikTok && process.env.TIKTOK_EVENTS_DESLIGADO !== '1') {
    await enviarTikTokVenda(pool, { funnel, sale, store, click, srcFinal, txId });
  }

  return { ok: true, motivo: motivoMeta };
}

async function enviarTikTokVenda(pool, { funnel, sale, store, click, srcFinal, txId }) {
  let pixels = [];
  try {
    const r = await pool.query('SELECT * FROM tiktok_pixels WHERE active AND domain = $1', [funnel.domain]);
    pixels = r.rows || [];
  } catch (e) {
    console.error('TIKTOK_FALHOU', JSON.stringify({ etapa: 'pixels', tx: txId, erro: String(e).slice(0, 200) }));
    return;
  }
  for (const px of pixels) {
    let status = 0; let payload = null;
    try {
      const r = await sendCompletePayment({ pixel: px, sale, store, click });
      status = r.httpStatus; payload = r.payload;
      const rejeitado = !!(r.response && r.response.code);
      if (status !== 200 || rejeitado) {
        console.error('TIKTOK_FALHOU', JSON.stringify({ pixel: px.pixel_code, tx: txId, status, resp: r.response }));
      }
      // TikTok rejeita com HTTP 200 + code != 0: no event_log vira status 0 (nao conta como aceito).
      if (rejeitado) status = 0;
    } catch (e) {
      console.error('TIKTOK_FALHOU', JSON.stringify({ pixel: px.pixel_code, tx: txId, erro: String(e).slice(0, 200) }));
    }
    try {
      await pool.query(
        `INSERT INTO event_log (event_name, event_id, source, src, funnel_id, http_status, payload, plataforma)
         VALUES ('CompletePayment',$1,'server',$2,$3,$4,$5,'tiktok')`,
        ['purchase_' + txId, srcFinal, funnel.id, status, payload ? JSON.stringify(payload) : null]);
    } catch (e) {
      console.error('TIKTOK_FALHOU', JSON.stringify({ etapa: 'event_log', pixel: px.pixel_code, erro: String(e).slice(0, 200) }));
    }
  }
}

module.exports = { processarVenda, herdarDoProduto, SQL_UPSERT_VENDA, SQL_HERDA_FUNIL_VENDA, SQL_HERDA_FUNIL_CLIQUE };
