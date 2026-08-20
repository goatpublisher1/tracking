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
const { tokenValido } = require('./auth');
const { normalizarPayt } = require('./payt');
const { processarVenda } = require('./vendas');
const { assinaturaValida, normalizarDigistore } = require('./digistore24');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Um client ocioso que recebe erro do backend (restart do Postgres, failover,
// redeploy do banco) faz o Pool emitir 'error'. EventEmitter sem listener em
// 'error' LANÇA e mata o processo — e isso acontece fora de qualquer try/catch.
pool.on('error', (err) => console.error('PG_POOL_ERROR', err));
process.on('unhandledRejection', (err) => console.error('UNHANDLED_REJECTION', err));
const app = express();
// Atrás do Traefik/Coolify. Sem isto, req.ip devolve o IP da rede interna do
// Docker (172.x), que vai parar em client_ip_address na CAPI e derruba o match.
// 1 = confia apenas no proxy imediato (não em X-Forwarded-For arbitrário).
app.set('trust proxy', 1);

// CORS: allowlist carregada dos funis, recarregada a cada 5 min para pegar
// dominio novo sem redeploy. Sem isso, refletir qualquer Origin + credentials
// (comportamento antigo) neutraliza a same-origin policy para qualquer
// endpoint de leitura que este servico venha a ganhar no futuro.
let origensPermitidas = new Set();
async function recarregaOrigens() {
  try {
    const { rows } = await pool.query('SELECT domain FROM funnels WHERE active');
    const s = new Set();
    for (const r of rows) {
      if (!r.domain) continue;
      const bare = r.domain.replace(/^www\./, '');
      s.add('https://' + bare);
      s.add('https://www.' + bare);
      s.add('https://track.' + bare);
    }
    origensPermitidas = s;
  } catch (e) { console.error('CORS_RELOAD_ERRO', e); }
}
recarregaOrigens();
setInterval(recarregaOrigens, 5 * 60 * 1000).unref();

// CORS_ORIGIN fica sempre ligado: é a janela de observação que substitui o
// deploy-e-espera-48h da brief (aqui tudo sobe de uma vez só). Mesmo esquema
// da Task 5 (PAYT_AUTH_ENFORCE): o gate nasce desligado, só loga quem seria
// negado, e só passa a negar de verdade com CORS_ALLOWLIST_ENFORCE=1.
// CORS só na rota /collect (o webhook e o /health não são chamados por
// browser). Allow-Credentials volta a viajar junto do Origin: nao pode ficar
// fora do gate, senao um checkout com `credentials:'include'` perde o
// preflight sem log nenhum e o kill switch nao desfaz.
app.use('/collect', function (req, res, next) {
  const o = req.headers.origin;
  if (o) console.log('CORS_ORIGIN', o);
  const permitida = o && origensPermitidas.has(o);
  if (o && !permitida) console.warn('CORS_ORIGEM_NEGADA', o);
  // enforce desligado: reflete mesmo assim (comportamento de hoje). O log
  // CORS_ORIGEM_NEGADA acima e o sinal que decide quando ligar o enforce.
  // allowlist vazia = nunca carregou (cold start / banco fora do ar) — nao e
  // informacao suficiente pra negar ninguem, entao falha aberto ate o
  // proximo reload (5 min) em vez de derrubar todo mundo por ate 5 min.
  if (o && (permitida || !origensPermitidas.size || process.env.CORS_ALLOWLIST_ENFORCE !== '1')) {
    res.header('Access-Control-Allow-Origin', o);
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb', type: ['application/json', 'text/plain'] }));
app.use(express.text({ limit: '1mb', type: 'text/*' }));
app.use(express.urlencoded({ extended: true }));

// resolve o funil ativo por domínio (host) — usado no /collect
async function funnelByDomain(host) {
  if (!host) return null;
  // remove prefixos track. e www. para casar com o dominio cadastrado.
  // Ex: track.seducaodamulher.shop -> seducaodamulher.shop -> www.seducaodamulher.shop
  const bare = host.replace(/^track\./, '').replace(/^www\./, '');
  const { rows } = await pool.query(
    `SELECT * FROM funnels WHERE active AND (domain = $1 OR domain = $2 OR domain = $3) LIMIT 1`,
    [host, bare, 'www.' + bare]
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
    // depois do guard de sck: bot batendo em host desconhecido sem sck nao
    // e o caso que o runbook manda gregar aqui — so afoga o sinal real.
    if (!funnel) console.warn('FUNIL_NAO_RESOLVIDO', JSON.stringify({ host, sck: b.sck || null }));

    // grava/atualiza o store (equivale ao Stape Store Writer) — chave = sck
    await pool.query(
      `INSERT INTO store (sck, src, fbp, fbc, ip_override, user_agent, page_location,
                          external_id, city, state, country, funnel_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (sck) DO UPDATE SET
         src=EXCLUDED.src, fbp=EXCLUDED.fbp, fbc=EXCLUDED.fbc,
         ip_override=EXCLUDED.ip_override, user_agent=EXCLUDED.user_agent,
         page_location=EXCLUDED.page_location, external_id=EXCLUDED.external_id,
         city=EXCLUDED.city, state=EXCLUDED.state, country=EXCLUDED.country,
         -- funnel_id era a UNICA coluna omitida aqui. Uma linha nascida com
         -- funil NULL nunca se recuperava, e a atribuicao caia no fallback por
         -- product_code — que manda a venda para o pixel do dominio errado.
         funnel_id=COALESCE(store.funnel_id, EXCLUDED.funnel_id)`,
      [b.sck, b.src, b.fbp, b.fbc, req.ip || b.ip, b.user_agent || req.headers['user-agent'],
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
      [b.sck, b.src, b.fbp, b.fbc, b.fbclid, req.ip || b.ip,
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

    // Gate de autenticação. A politica de "sempre 200" cobre ERRO INTERNO;
    // requisicao nao autenticada nao e a PayT e recebe 401.
    // Desligavel em segundos pelo Coolify: PAYT_AUTH_ENFORCE=0, sem rebuild.
    // A PayT manda integration_key no topo do payload e documenta que ela
    // existe para validar a origem do postback. E uma chave de CONTA (a mesma
    // para todos os postbacks), entao prova "veio da nossa PayT" — nao diz de
    // qual funil. Atribuicao de funil/dominio continua vindo do sck.
    const chave = typeof p?.integration_key === 'string' ? p.integration_key : '';
    const chaveOk = tokenValido(chave, process.env.PAYT_INTEGRATION_KEY);
    if (!chaveOk) {
      console.warn('PAYT_AUTH_NEGADO', JSON.stringify({
        ip: req.ip, presente: !!chave, tx: p?.transaction_id || null,
        teste: !!p?.test,
      }));
      if (process.env.PAYT_AUTH_ENFORCE === '1') return res.sendStatus(401);
    }

    // LOG TEMPORARIO: registra o payload para descobrir onde a PayT poe o sck.
    // Remover depois de identificar a estrutura.
    try { console.log('PAYT_WEBHOOK', JSON.stringify(p).slice(0, 2000)); } catch (e) {}

    const venda = normalizarPayt(p);
    const { sck, src, paid, value, total, txId } = venda;
    const statusBruto = venda.status;

    if (!p?.transaction_id && txId) console.warn('PAYT_TXID_FALLBACK', txId);

    // se a PayT mudar o vocabulario de status, hoje as conversoes parariam de
    // ser enviadas sem nenhum sinal. Este log e o sinal.
    const CONHECIDOS = ['paid','waiting_payment','pending','refused','canceled','refunded','chargeback','expired'];
    if (statusBruto && !CONHECIDOS.includes(statusBruto)) {
      console.warn('PAYT_STATUS_DESCONHECIDO', statusBruto, p?.transaction_id);
    }

    // sempre grava a venda (mesmo não-paid) para o painel/atribuição
    // commission nao-array faz o .find e o fallback [0] falharem -> value 0.
    // Purchase com value 0 conta como conversao e puxa o ROAS aprendido pra baixo.
    if (paid && !(value > 0)) {
      console.error('VENDA_SEM_COMISSAO', JSON.stringify({
        tx: p?.transaction_id, commission: p?.commission,
      }));
    }
    if (!txId) {
      console.error('PAYT_SEM_TXID', JSON.stringify(p).slice(0, 500));
      return res.json({ ok: false, motivo: 'sem_transaction_id' });
    }

    await processarVenda(pool, venda);

    res.json({ ok: true }); // sempre 200 rápido p/ a PayT não re-tentar à toa
  } catch (e) {
    console.error('payt webhook error', e);
    res.status(200).json({ ok: false }); // 200 mesmo em erro evita retry storm
  }
});

// ---------------------------------------------------------------------
//  /webhook/digistore24 — IPN da Digistore24.
//  Diferencas em relacao a PayT, ambas deliberadas:
//   - autentica por assinatura SHA-512 do payload, nao por chave estatica;
//   - responde texto puro, nao JSON: a Digistore24 so considera a chamada
//     bem-sucedida se receber o token esperado, e reenvia ate 20 vezes ao
//     longo de 10 dias quando falha.
// ---------------------------------------------------------------------
app.post('/webhook/digistore24', async (req, res) => {
  try {
    const p = req.body || {};

    const ok = assinaturaValida(p, process.env.DIGISTORE_IPN_PASSPHRASE);
    if (!ok) {
      console.warn('DIGISTORE_AUTH_NEGADO', JSON.stringify({
        ip: req.ip,
        presente: !!(p && p.sha_sign),
        tx: (p && p.transaction_id) || null,
        teste: p && p.api_mode === 'test',
      }));
      if (process.env.DIGISTORE_AUTH_ENFORCE === '1') return res.sendStatus(401);
    }

    // LOG TEMPORARIO: descobrir o formato real do IPN em producao.
    try { console.log('DIGISTORE_IPN', JSON.stringify(p).slice(0, 2000)); } catch (e) {}

    const venda = normalizarDigistore(p);

    const CONHECIDOS = ['payment', 'refund', 'chargeback'];
    if (venda.status && !CONHECIDOS.includes(venda.status)) {
      console.warn('DIGISTORE_STATUS_DESCONHECIDO', venda.status, venda.txIdBruto);
    }

    if (!venda.txId) {
      console.error('DIGISTORE_SEM_TXID', JSON.stringify(p).slice(0, 500));
      return res.send('OK');
    }

    if (venda.paid && !(venda.value > 0)) {
      console.error('DIGISTORE_SEM_VALOR', JSON.stringify({
        tx: venda.txIdBruto, amount_vendor: p.amount_vendor,
      }));
    }

    await processarVenda(pool, venda);

    res.send('OK');
  } catch (e) {
    console.error('digistore24 webhook error', e);
    // mesmo em erro interno respondemos OK: a alternativa e a Digistore24
    // reenviar 20 vezes o mesmo payload que ja falhou. A falha fica no log.
    res.send('OK');
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('tracking service on :' + PORT));
