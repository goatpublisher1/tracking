// =====================================================================
//  capi.js — Cliente da Meta Conversions API
//  Réplica do template "Facebook Conversion API" dos containers.
//  Purchase: 12 user_data + custom_data (value=comissão, currency=BRL).
//  event_id = "purchase_" + transaction_id  (protege contra reenvio).
// =====================================================================
const crypto = require('crypto');

const GRAPH = 'https://graph.facebook.com/v20.0';

// hash SHA-256 lowercase/trim — exigido pela Meta para dados pessoais
function hash(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return crypto.createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

// telefone: só dígitos antes de hashear
function hashPhone(value) {
  if (!value) return undefined;
  return hash(String(value).replace(/\D/g, ''));
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

// monta e envia o evento Purchase para a CAPI
async function sendPurchase({ funnel, sale, store }) {
  const { fn, ln } = splitName(sale.customer_name);

  // user_data — os mesmos 12 campos do container (em, ph, fn, ln, ct, st,
  // country, client_user_agent, client_ip_address, fbc, fbp, external_id)
  const user_data = clean({
    em: hash(sale.customer_email),
    ph: hashPhone(sale.customer_phone),
    fn, ln,
    ct: hash(store?.city),
    st: hash(store?.state),
    country: hash(store?.country),
    client_user_agent: store?.user_agent || undefined,
    client_ip_address: store?.ip_override || undefined,
    fbc: store?.fbc || undefined,
    fbp: store?.fbp || undefined,
    external_id: store?.external_id ? hash(store.external_id) : undefined,
  });

  const custom_data = clean({
    currency: funnel.currency || 'BRL',
    value: Number(sale.value) || 0,          // comissão, conforme decidido
    content_ids: sale.product_code ? [sale.product_code] : undefined,
    content_name: sale.product_name || undefined,
    order_id: sale.transaction_id,
  });

  const event = clean({
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    // event_id = sck (o mesmo id único gerado no clique). Mantém consistência
    // com o InitiateCheckout e deduplica reenvios do webhook.
    event_id: store?.sck || ('purchase_' + sale.transaction_id),
    action_source: 'website',
    event_source_url: store?.page_location || undefined,
    user_data,
    custom_data,
  });

  const url = `${GRAPH}/${funnel.pixel_id}/events?access_token=${funnel.capi_token}`;
  const body = { data: [event] };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, response: json, payload: event };
}

// remove chaves undefined/null (a Meta rejeita campos vazios)
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

module.exports = { sendPurchase, hash, hashPhone };
