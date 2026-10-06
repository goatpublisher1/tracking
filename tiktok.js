// =====================================================================
//  tiktok.js - Cliente da TikTok Events API (v1.3).
//  Espelho do capi.js para a TikTok: dois eventos, InitiateCheckout (do
//  /collect, event_id = sck, deduplica com o pixel em 48h) e CompletePayment
//  (do webhook, event_id = purchase_<tx>). `user` leva o que a TikTok pesa na
//  correspondencia: ttclid (id de clique), ttp (cookie), ip, user agent,
//  e-mail/telefone/external_id em SHA-256.
//  O pixel da TikTok mora em tiktok_pixels (varios por dominio), nao em funnels.
// =====================================================================
const { hash } = require('./capi');
const { normTelefone } = require('./geo');

const EVENTS_API = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

// A TikTok pede E.164 com o '+'. Se o numero ja vem com '+', o codigo do pais
// e dele (normTelefone poria 55 num numero de 11 digitos); senao normTelefone resolve.
function telefoneE164(v) {
  const d = String(v || '').trim().startsWith('+') ? String(v).replace(/\D/g, '') : normTelefone(v);
  return d ? '+' + d : undefined;
}

function segundos(d) {
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 1000);
}

// identificadores do navegador, comuns aos dois eventos
function userBase({ store, click, sck, ipFallback }) {
  return {
    external_id: sck ? hash(sck) : undefined,
    ttclid: click?.ttclid || undefined,
    ttp: click?.ttp || undefined,
    ip: store?.ip_override || click?.ip || ipFallback || undefined,
    user_agent: store?.user_agent || click?.user_agent || undefined,
  };
}

function buildCompletePaymentEvent({ pixel, sale, store, click }) {
  const user = clean({
    email: hash(sale.customer_email),
    phone: hash(telefoneE164(sale.customer_phone)),
    ...userBase({ store, click, sck: sale.sck || store?.sck, ipFallback: sale.ip }),
  });
  const properties = clean({
    value: Number(sale.value) || 0,
    currency: sale.currency || 'BRL',
    content_type: 'product',
    order_id: sale.transaction_id,
    contents: sale.product_code
      ? [clean({ content_id: sale.product_code, content_name: sale.product_name || undefined, quantity: 1, price: Number(sale.value) || 0 })]
      : undefined,
  });
  return clean({
    event: 'CompletePayment',
    event_time: sale.event_time || Math.floor(Date.now() / 1000),
    event_id: 'purchase_' + sale.transaction_id,
    user,
    properties,
    page: clean({ url: store?.page_location || click?.landing_url || undefined }),
  });
}

// A TikTok exige user_agent em evento de site; sem sck nao ha event_id.
function buildInitiateCheckoutEvent({ pixel, click }) {
  if (!click || !click.sck || !click.user_agent) return null;
  return clean({
    event: 'InitiateCheckout',
    event_time: segundos(click.created_at || Date.now()),
    event_id: click.sck,
    user: clean(userBase({ store: null, click, sck: click.sck })),
    page: clean({ url: click.landing_url || undefined }),
  });
}

async function sendTikTokEvent({ pixel, event }) {
  const body = { event_source: 'web', event_source_id: pixel.pixel_code, data: [event] };
  // So para a aba Test Events; em producao fica vazio (evento de teste nao otimiza).
  const teste = (process.env.TIKTOK_TEST_EVENT_CODE || '').trim();
  if (teste) body.test_event_code = teste;
  const res = await fetch(EVENTS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Access-Token': pixel.access_token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, response: json, payload: event };
}

async function sendCompletePayment({ pixel, sale, store, click }) {
  return sendTikTokEvent({ pixel, event: buildCompletePaymentEvent({ pixel, sale, store, click }) });
}

async function sendInitiateCheckout({ pixel, click }) {
  const event = buildInitiateCheckoutEvent({ pixel, click });
  if (!event) return { httpStatus: 0, response: { skipped: 'sem_sck_ou_user_agent' }, payload: null };
  return sendTikTokEvent({ pixel, event });
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

module.exports = {
  buildCompletePaymentEvent, buildInitiateCheckoutEvent,
  sendTikTokEvent, sendCompletePayment, sendInitiateCheckout, telefoneE164,
};
