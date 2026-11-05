// =====================================================================
//  hw.js — normalizacao do postback de afiliado da H&W Hub (hwaffiliate.com).
//
//  Mesmo papel do digistore24-afiliado.js (comissao de produto de terceiro,
//  funil fixo na URL, nunca vai para a Meta), com duas diferencas:
//   - POST com JSON, e os nomes dos campos sao escolha nossa (mapeamento do
//     postback no painel da H&W, ver HANDOFF.md);
//   - traz o clique: a H&W guarda os parametros da URL do checkout e o
//     postback devolve qualquer um como "campo personalizado". O header ja poe
//     sck e utm_* em todo link da pagina, entao a venda acha a campanha.
//
//  Funcao pura: sem banco, sem rede.
// =====================================================================

// Prefixo proprio: o numero do pedido da H&W nao pode colidir com o
// transaction_id de outra plataforma em sales.transaction_id.
const PREFIXO = 'hw_';
const UTMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function texto(v) {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// O postback so dispara em "Pedido concluido", entao chega pago. O vocabulario
// de sale.status nao e documentado: so muda o pago quando diz o contrario.
function traduzirStatus(bruto) {
  const s = String(bruto || '').toLowerCase();
  if (/chargeback/.test(s)) return 'chargeback';
  if (/refund|reembols|estorn/.test(s)) return 'refunded';
  if (/pend|wait|aguard/.test(s)) return 'pending';
  if (/cancel|fail|falh|refus|recus|declin/.test(s)) return 'canceled';
  return 'paid';
}

// Reserva do sck: se a H&W nao devolver o campo personalizado, a URL do
// checkout ainda o traz (o header o pos no link).
function sckDaUrl(url) {
  try {
    return new URL(url).searchParams.get('sck') || null;
  } catch {
    return null;
  }
}

function normalizarHw(body, query) {
  const p = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
  const q = (query && typeof query === 'object' && !Array.isArray(query)) ? query : {};

  const txBruto = texto(p.orderNumber);
  const statusBruto = texto(p.status);
  const status = txBruto ? traduzirStatus(statusBruto) : null;
  const oferta = texto(p.oferta);

  const utms = {};
  for (const k of UTMS) if (texto(p[k])) utms[k] = p[k];

  return {
    origem: 'hw',
    txId: txBruto ? PREFIXO + txBruto : null,
    txIdBruto: txBruto,
    status,
    statusBruto,
    paid: status === 'paid',
    teste: false,
    value: num(p.payout),     // a comissao: a nossa receita nesta venda
    total: 0,                 // o postback nao tem o bruto pago pelo cliente
    currency: texto(p.currency),
    // A oferta vem como campo fixo do postback: e o codigo cadastrado no funil
    // (send_to_meta = false), que tira a venda do "Vendas real" do Meta.
    productCode: oferta ? PREFIXO + oferta : null,
    productName: texto(p.productName),
    paidAt: texto(p.paidAt),
    upsellFrom: null,

    funnelSlug: texto(q.funil),
    // Comissao de produto de terceiro nao pode inflar a otimizacao das nossas
    // campanhas. Ver vendas.js.
    enviarMeta: false,
    offerType: 'upsell',

    sck: texto(p.sck) || sckDaUrl(p.checkoutUrl),
    src: null,
    utms: Object.keys(utms).length ? utms : null,
    email: null,
    phone: null,
    city: null,
    state: null,
    country: null,
    nome: null,
    paymentMethod: null,
    ip: null,
    pixelId: null,
  };
}

module.exports = { normalizarHw, traduzirStatus };
