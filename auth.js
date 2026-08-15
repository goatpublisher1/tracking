// =====================================================================
//  auth.js — comparação de segredo em tempo constante
// =====================================================================
const crypto = require('crypto');

// true só se ambos forem strings não-vazias, de mesmo tamanho e iguais.
// timingSafeEqual lança se os buffers tiverem tamanhos diferentes, por isso
// o tamanho é checado antes.
function tokenValido(recebido, esperado) {
  if (typeof recebido !== 'string' || typeof esperado !== 'string') return false;
  if (!recebido || !esperado) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { tokenValido };
