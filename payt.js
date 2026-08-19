// =====================================================================
//  payt.js — traduz o payload da PayT para o formato interno.
//  Funcao pura: sem banco, sem rede. E o ponto de teste que o handler
//  monolitico nao tinha.
// =====================================================================

// A PayT expoe os parametros da URL em locais que variam por venda.
function digSck(o) {
  if (!o || typeof o !== 'object') return null;
  const paths = [
    o?.link?.query_params?.sck,          // caso mais comum (nosso idx_)
    o?.customer?.origin?.query_params?.sck,
    o?.link?.sources?.sck,
    o?.sources?.sck,
    o?.query_params?.sck,
    o?.url_parameters?.sck,
    o?.url_params?.sck,
    o?.tracking?.sck,
    o?.checkout?.url_parameters?.sck,
    o?.sck,
  ].filter(Boolean);
  // prioriza o nosso sck (idx_), que casa com o store; senao usa o primeiro
  const nosso = paths.find(v => typeof v === 'string' && v.indexOf('idx_') === 0);
  return nosso || paths[0] || null;
}

function digSrc(o) {
  if (!o || typeof o !== 'object') return null;
  const paths = [
    o?.link?.query_params?.src, o?.link?.sources?.src, o?.sources?.src,
    o?.query_params?.src, o?.url_parameters?.src,
    o?.url_params?.src, o?.tracking?.src, o?.src,
  ];
  for (const v of paths) if (v) return v;
  return null;
}

function normalizarPayt(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};

  // status de pagamento fica em transaction.payment_status; o de order em status.
  // O OR e deliberado: (A || B) === 'paid' NAO e equivalente e mudaria o
  // comportamento quando payment_status vem preenchido mas diferente de 'paid'.
  const paid = p?.transaction?.payment_status === 'paid' || p?.status === 'paid';
  const status = p?.transaction?.payment_status || p?.status || null;

  // value = comissao do PRODUTOR (busca por type, nao indice fixo)
  const producerComm = Array.isArray(p?.commission)
    ? p.commission.find(c => c?.type === 'producer') : null;
  const value = Number(producerComm?.amount ?? p?.commission?.[0]?.amount ?? 0) / 100;

  const txId = p?.transaction_id ?? p?.transaction?.id ?? p?.id ?? null;

  return {
    origem: 'payt',
    txId,
    txIdBruto: txId,
    sck: digSck(p) || p?.customer?.origin?.query_params?.click_id || null,
    src: digSrc(p) || null,
    status,
    paid,
    teste: false,                                   // a PayT nao marca teste no payload
    value: Number.isFinite(value) ? value : 0,
    total: Number(p?.transaction?.total_price ?? 0) / 100,  // centavos -> reais
    productCode: p?.product?.code ?? null,
    productName: p?.product?.name ?? null,
    email: p?.customer?.email ?? null,
    phone: p?.customer?.phone ?? null,
    nome: p?.customer?.name ?? null,
    paymentMethod: p?.transaction?.payment_method ?? null,
    paidAt: p?.transaction?.paid_at ?? null,
    upsellFrom: p?.transaction?.upsell_from ?? null,
    ip: p?.customer?.ip ?? null,
    pixelId: p?.pixel_id ?? null,
  };
}

module.exports = { normalizarPayt };
