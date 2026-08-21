// =====================================================================
//  digistore24.js — assinatura e normalizacao do IPN da Digistore24.
//  Funcoes puras: sem banco, sem rede.
// =====================================================================
const crypto = require('crypto');
const { tokenValido } = require('./auth');

// Algoritmo do guia oficial de IPN (pagina 20):
// remove sha_sign, ordena as chaves sem diferenciar maiusculas, e concatena
// "nome=valor" + passphrase para cada parametro, sem separador. SHA-512 hex.
function stringParaAssinar(params, passphrase) {
  return Object.keys(params)
    .filter(k => k !== 'sha_sign' && k !== 'SHASIGN')
    .sort((a, b) => {
      const x = a.toLowerCase(), y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map(k => `${k}=${params[k]}${passphrase}`)
    .join('');
}

function assinaturaValida(params, passphrase) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  if (typeof passphrase !== 'string' || !passphrase) return false;

  const recebida = params.sha_sign || params.SHASIGN;
  if (typeof recebida !== 'string' || !recebida) return false;

  const esperada = crypto
    .createHash('sha512')
    .update(stringParaAssinar(params, passphrase), 'utf8')
    .digest('hex')
    .toUpperCase();

  // comparacao em tempo constante (mesma usada no gate da PayT)
  return tokenValido(recebida.toUpperCase(), esperada);
}

const PREFIXO = 'ds24_';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// A Digistore24 manda o tipo com inicial maiuscula ("Payment") e num vocabulario proprio;
// a PayT grava 'paid'/'refunded'. Quem le a tabela `sales` — o dashboard, um relatorio, o
// proximo gateway — nao pode precisar saber por onde a venda entrou, entao a traducao mora
// aqui, na fronteira. Sem isto, 'Payment' era gravado cru, nao batia com o filtro de venda
// paga do dashboard, e `paid` ficava false — o que impedia o Purchase de ir para a Meta.
const STATUS_DIGISTORE = {
  payment: 'paid',
  refund: 'refunded',
  chargeback: 'chargeback',
  // billing_status, usado quando o IPN nao traz transaction_type
  completed: 'paid',
  pending: 'pending',
  missed: 'pending',
};

function traduzirStatus(p) {
  const bruto = String(p.transaction_type || p.billing_status || '').trim().toLowerCase();
  if (!bruto) return null;
  // Valor desconhecido sai como veio, em minusculas: o server avisa no log, e gravar o
  // original preserva a evidencia de qual estado a Digistore24 mandou.
  return STATUS_DIGISTORE[bruto] || bruto;
}

// Os valores da Digistore24 ja vem em unidade monetaria (97.00), nao em
// centavos como na PayT — por isso nao ha divisao por 100 aqui.
function normalizarDigistore(params) {
  const p = (params && typeof params === 'object' && !Array.isArray(params)) ? params : {};

  const txBruto = p.transaction_id || null;
  const nome = [p.address_first_name, p.address_last_name]
    .filter(Boolean).join(' ') || null;

  return {
    origem: 'digistore24',
    txId: txBruto ? PREFIXO + txBruto : null,
    txIdBruto: txBruto,
    sck: p.custom || null,
    // sid1 e do postback S2S de afiliado, nao existe no IPN de venda -> src
    // fica sempre null nesta plataforma (nao e bug, nao precisa investigar).
    src: p.sid1 || null,
    status: traduzirStatus(p),
    paid: traduzirStatus(p) === 'paid',
    teste: p.api_mode === 'test',
    value: num(p.amount_vendor),      // a parte do vendedor
    total: num(p.amount_brutto),      // o que o cliente pagou
    productCode: p.product_id ? PREFIXO + p.product_id : null,
    productName: p.product_name || null,
    email: p.buyer_email || null,
    phone: p.address_phone_no || null,
    city: p.address_city || null,
    state: p.address_state || null,
    country: p.address_country || null,
    nome,
    paymentMethod: p.pay_method || null,
    paidAt: p.transaction_processed_at || null,
    upsellFrom: p.order_id || null,
    ip: null,                          // o IPN nao traz o ip do comprador
    pixelId: null,
  };
}

module.exports = { assinaturaValida, stringParaAssinar, normalizarDigistore };
