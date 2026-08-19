const { test } = require('node:test');
const assert = require('node:assert');
const { assinaturaValida } = require('../digistore24');

// vetor oficial da documentacao Digistore24 (guia de IPN, pagina 20)
const PASSPHRASE = 'xxxxx';
const PARAMS = {
  buyer_email: 'claus@domain-xyz.de',
  payment_id: 'PAYID-39-22012',
  order_id: '273732',
  transaction_amount: '17.00',
  transaction_currency: 'USD',
};
const ASSINATURA = '342770076245D14ED7DF4D2E5D82216D7EDF8F9E7969B5964C9C5DCB53E962BB'
  + 'ECD545E90422B5329C69554FD8B1A7E7410736615FCA7FB5CBB3624CC016E4BC';

test('aceita a assinatura do vetor oficial', () => {
  assert.strictEqual(assinaturaValida({ ...PARAMS, sha_sign: ASSINATURA }, PASSPHRASE), true);
});

test('a ordem das chaves no objeto nao importa', () => {
  const invertido = {};
  for (const k of Object.keys(PARAMS).reverse()) invertido[k] = PARAMS[k];
  assert.strictEqual(assinaturaValida({ ...invertido, sha_sign: ASSINATURA }, PASSPHRASE), true);
});

test('aceita assinatura em minusculas', () => {
  assert.strictEqual(
    assinaturaValida({ ...PARAMS, sha_sign: ASSINATURA.toLowerCase() }, PASSPHRASE), true);
});

test('rejeita passphrase errada', () => {
  assert.strictEqual(assinaturaValida({ ...PARAMS, sha_sign: ASSINATURA }, 'outra'), false);
});

test('rejeita se qualquer parametro foi adulterado', () => {
  const p = { ...PARAMS, transaction_amount: '1700.00', sha_sign: ASSINATURA };
  assert.strictEqual(assinaturaValida(p, PASSPHRASE), false);
});

test('rejeita se um parametro foi acrescentado', () => {
  const p = { ...PARAMS, extra: 'x', sha_sign: ASSINATURA };
  assert.strictEqual(assinaturaValida(p, PASSPHRASE), false);
});

test('rejeita sem sha_sign, sem passphrase, ou com entrada invalida', () => {
  assert.strictEqual(assinaturaValida(PARAMS, PASSPHRASE), false);
  assert.strictEqual(assinaturaValida({ ...PARAMS, sha_sign: ASSINATURA }, ''), false);
  assert.strictEqual(assinaturaValida({ ...PARAMS, sha_sign: ASSINATURA }, undefined), false);
  assert.strictEqual(assinaturaValida(null, PASSPHRASE), false);
  assert.strictEqual(assinaturaValida('texto', PASSPHRASE), false);
});
