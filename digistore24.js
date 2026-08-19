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

module.exports = { assinaturaValida, stringParaAssinar };
