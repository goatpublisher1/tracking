// =====================================================================
//  capi.js — Cliente da Meta Conversions API
//  Réplica do template "Facebook Conversion API" dos containers.
//  Purchase: 12 user_data + custom_data (value=comissão, currency=BRL).
//  event_id = "purchase_" + transaction_id  (protege contra reenvio).
//  InitiateCheckout: 5 user_data do clique, event_id = sck (dedupe com o pixel).
// =====================================================================
const crypto = require('crypto');
const { normCidade, normEstado, normPais, normTelefone } = require('./geo');

const GRAPH = 'https://graph.facebook.com/v20.0';

// hash SHA-256 lowercase/trim — exigido pela Meta para dados pessoais
function hash(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return crypto.createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

// separa nome completo em first/last (equivale aos RegEx do container)
function splitName(full) {
  if (!full) return { fn: undefined, ln: undefined };
  const parts = String(full).trim().split(/\s+/);
  return {
    fn: hash(parts[0]),
    ln: parts.length > 1 ? hash(parts[parts.length - 1]) : undefined,
  };
}

// fbc: o cookie _fbc quando existe; senao o formato que a Meta documenta para
// montar a partir do fbclid da URL: fb.1.<ms do clique>.<fbclid>. fbclid cru
// nunca sai — a Meta nao aceita.
function fbcDe(fbc, fbclid, criadoEm) {
  if (fbc) return fbc;
  if (!fbclid || !criadoEm) return undefined;
  const ms = criadoEm instanceof Date ? criadoEm.getTime() : new Date(criadoEm).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return `fb.1.${ms}.${fbclid}`;
}

// A parte do user_data que vem do navegador, comum a Purchase e IC.
// `store` e a linha de store (checkout); `click` e a linha de clicks.
// O sck e o id proprio do visitante: vira external_id (hash), estavel do
// primeiro clique ate a compra — e o que liga os eventos da mesma pessoa.
function userDataBase({ store, click, sck, ipFallback }) {
  return {
    client_user_agent: store?.user_agent || click?.user_agent || undefined,
    client_ip_address: store?.ip_override || click?.ip || ipFallback || undefined,
    fbc: fbcDe(store?.fbc || click?.fbc, click?.fbclid, click?.created_at),
    fbp: store?.fbp || click?.fbp || undefined,
    external_id: sck ? hash(sck) : (store?.external_id ? hash(store.external_id) : undefined),
  };
}

// monta o evento Purchase (puro, sem rede — exportado para teste)
function buildPurchaseEvent({ funnel, sale, store, click }) {
  const { fn, ln } = splitName(sale.customer_name);

  // geo: o store nunca teve (o header nao manda), entao na pratica vem da
  // venda — a Digistore24 manda cidade/estado/pais no IPN. PayT nao manda.
  const user_data = clean({
    em: hash(sale.customer_email),
    ph: hash(normTelefone(sale.customer_phone)),
    fn, ln,
    ct: hash(normCidade(store?.city || sale.city)),
    st: hash(normEstado(store?.state || sale.state)),
    country: hash(normPais(store?.country || sale.country)),
    ...userDataBase({ store, click, sck: sale.sck || store?.sck, ipFallback: sale.ip }),
  });

  const custom_data = clean({
    currency: funnel.currency || 'BRL',
    value: Number(sale.value) || 0,          // comissão, conforme decidido
    content_ids: sale.product_code ? [sale.product_code] : undefined,
    content_name: sale.product_name || undefined,
    order_id: sale.transaction_id,
  });

  return clean({
    event_name: 'Purchase',
    event_time: sale.event_time || Math.floor(Date.now() / 1000),
    // event_id derivado da TRANSACAO, nao do sck. O sck identifica a sessao:
    // uma compra + um upsell na mesma sessao geravam o mesmo event_id e a Meta
    // descartava o segundo. A dedupe da Meta so opera entre eventos de mesmo
    // event_name, entao compartilhar o id com o InitiateCheckout nao trazia
    // beneficio nenhum. Reenvio do mesmo webhook continua deduplicado.
    event_id: 'purchase_' + sale.transaction_id,
    action_source: 'website',
    event_source_url: store?.page_location || click?.landing_url || undefined,
    user_data,
    custom_data,
  });
}

// monta o InitiateCheckout server-side a partir da linha de clicks. event_id =
// sck cru: e o eventID que o header ja manda no fbq('track','InitiateCheckout'),
// e e por ele que a Meta deduplica pixel x servidor (48h). Sem custom_data.
function buildInitiateCheckoutEvent({ funnel, click }) {
  if (!click || !click.sck) return null;
  return clean({
    event_name: 'InitiateCheckout',
    event_time: Math.floor((click.created_at ? new Date(click.created_at).getTime() : Date.now()) / 1000),
    event_id: click.sck,
    action_source: 'website',
    event_source_url: click.landing_url || undefined,
    user_data: clean(userDataBase({ store: null, click, sck: click.sck })),
  });
}

// envia um evento ja montado para o pixel do funil
async function sendEvent({ funnel, event }) {
  const url = `${GRAPH}/${funnel.pixel_id}/events`;
  // token no corpo, nao na query: a URL aparece em qualquer log de erro
  // que a imprima e em traces de biblioteca HTTP.
  const body = { data: [event], access_token: funnel.capi_token };
  // Com META_TEST_EVENT_CODE definido os eventos aparecem em tempo real na aba
  // "Testar eventos" do Gerenciador de Eventos e NAO contam para otimizacao.
  // So para conferir a integracao; em producao fica vazio.
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // undici não tem timeout de request por padrão (só headersTimeout ~5min).
    // O loop de pixels em server.js é sequencial, então o pior caso soma.
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, response: json, payload: event };
}

async function sendPurchase({ funnel, sale, store, click }) {
  return sendEvent({ funnel, event: buildPurchaseEvent({ funnel, sale, store, click }) });
}

async function sendInitiateCheckout({ funnel, click }) {
  const event = buildInitiateCheckoutEvent({ funnel, click });
  if (!event) return { httpStatus: 0, response: { skipped: 'sem_sck' }, payload: null };
  return sendEvent({ funnel, event });
}

// remove chaves undefined/null (a Meta rejeita campos vazios)
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

module.exports = {
  sendPurchase, sendInitiateCheckout, sendEvent,
  buildPurchaseEvent, buildInitiateCheckoutEvent, fbcDe, hash,
};
