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
    status: p.transaction_type || p.billing_status || null,
    // transaction_type: payment | refund | chargeback
    paid: p.transaction_type === 'payment',
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
