// =====================================================================
//  digistore24-afiliado.js — normalizacao do Postback S2S de afiliado.
//
//  Canal diferente do IPN de venda (digistore24.js), nao uma variacao dele:
//   - o IPN e configurado pelo vendor dentro do produto; este e configurado
//     na nossa conta e dispara nas vendas dos nossos links, em produto de
//     terceiro;
//   - chega como GET com query string, e os nomes dos parametros sao escolha
//     nossa (montamos a URL no painel);
//   - a nossa receita e a comissao (amount_affiliate_abs), nao a parte do
//     vendedor.
//
//  Funcao pura: sem banco, sem rede.
// =====================================================================
const { traduzirStatus } = require('./digistore24');

// Prefixo proprio, nao o ds24_ do IPN de vendor: se um dia formos vendor e
// afiliado do mesmo produto, o mesmo transaction_id chegaria pelos dois canais
// e as duas linhas colidiriam em sales.transaction_id, a chave de deduplicacao.
const PREFIXO = 'ds24a_';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizarAfiliado(query) {
  const q = (query && typeof query === 'object' && !Array.isArray(query)) ? query : {};

  const txBruto = q.transactionId || null;
  // traduzirStatus le transaction_type || billing_status; a nossa URL manda os
  // mesmos dois valores com outros nomes.
  const status = traduzirStatus({
    transaction_type: q.transactionType,
    billing_status: q.status,
  });

  return {
    origem: 'digistore24_afiliado',
    txId: txBruto ? PREFIXO + txBruto : null,
    txIdBruto: txBruto,
    status,
    paid: status === 'paid',
    teste: q.isTest === '1',
    value: num(q.commission),      // a comissao: a nossa receita nesta venda
    total: num(q.amountGross),     // o que o cliente pagou ao vendedor
    productCode: q.productId ? PREFIXO + q.productId : null,
    productName: q.productName || null,
    country: q.country || null,
    paidAt: q.dateTime || null,
    upsellFrom: q.orderId || null,

    // O funil vem fixo na URL: sem sck e sem produto cadastrado, nada mais
    // resolveria, e venda com funnel_id nulo e invisivel no dashboard.
    funnelSlug: q.funil || null,
    // Comissao de produto de terceiro nao pode inflar a otimizacao das nossas
    // campanhas. Ver vendas.js.
    enviarMeta: false,
    offerType: 'backend',

    // O postback nao traz nada do comprador nem do clique. Nulo honesto e
    // melhor que valor inventado a partir de campo parecido.
    sck: null,
    src: null,
    email: null,
    phone: null,
    city: null,
    state: null,
    nome: null,
    paymentMethod: null,
    ip: null,
    pixelId: null,
  };
}

module.exports = { normalizarAfiliado };
