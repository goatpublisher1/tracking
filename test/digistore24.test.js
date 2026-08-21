const { test } = require('node:test');
const assert = require('node:assert');
const { assinaturaValida, normalizarDigistore } = require('../digistore24');

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

// campos conforme o guia oficial de IPN (ipn_version 1.2)
const IPN = {
  ipn_version: '1.2',
  api_mode: 'live',
  order_id: '34DEFS45DE2',
  transaction_id: 'TX999',
  transaction_type: 'payment',
  billing_status: 'completed',
  custom: 'idx_abc123',
  product_id: '122343',
  product_name: 'Produto Y',
  amount_brutto: '97.00',
  amount_netto: '81.51',
  amount_vendor: '51.00',
  amount_affiliate: '21.85',
  currency: 'BRL',
  buyer_email: 'a@b.com',
  address_first_name: 'Ana',
  address_last_name: 'Maria',
  address_phone_no: '11988887777',
  address_city: 'Sao Paulo',
  address_state: 'SP',
  address_country: 'BR',
  pay_sequence_no: '0',
};

test('prefixa txId e productCode com ds24_', () => {
  const v = normalizarDigistore(IPN);
  assert.strictEqual(v.txId, 'ds24_TX999');
  assert.strictEqual(v.txIdBruto, 'TX999');
  assert.strictEqual(v.productCode, 'ds24_122343');
});

test('value vem de amount_vendor, nao de netto nem de brutto', () => {
  const v = normalizarDigistore(IPN);
  assert.strictEqual(v.value, 51);
  assert.strictEqual(v.total, 97);
});

test('sck vem de custom', () => {
  assert.strictEqual(normalizarDigistore(IPN).sck, 'idx_abc123');
});

test('paid so em transaction_type payment', () => {
  assert.strictEqual(normalizarDigistore(IPN).paid, true);
  assert.strictEqual(normalizarDigistore({ ...IPN, transaction_type: 'refund' }).paid, false);
  assert.strictEqual(normalizarDigistore({ ...IPN, transaction_type: 'chargeback' }).paid, false);
});

// A Digistore24 manda o tipo com inicial maiuscula. O fixture acima usa minuscula, que era a
// suposicao errada — a primeira venda real chegou como 'Payment', gravou status cru, nao bateu
// com o filtro de venda paga do dashboard, e deixou paid false, o que impediu o Purchase de ir
// para a Meta. Estes testes travam a caixa e a traducao.
test('transaction_type com inicial maiuscula e tratado igual', () => {
  assert.strictEqual(normalizarDigistore({ ...IPN, transaction_type: 'Payment' }).paid, true);
  assert.strictEqual(normalizarDigistore({ ...IPN, transaction_type: 'Payment' }).status, 'paid');
  assert.strictEqual(normalizarDigistore({ ...IPN, transaction_type: 'REFUND' }).status, 'refunded');
  assert.strictEqual(normalizarDigistore({ ...IPN, transaction_type: ' Chargeback ' }).status, 'chargeback');
});

test('status sai no vocabulario da PayT, nao no da Digistore24', () => {
  assert.strictEqual(normalizarDigistore(IPN).status, 'paid', 'payment vira paid, senao o dashboard nao conta a venda');
  assert.strictEqual(normalizarDigistore({ ...IPN, transaction_type: 'refund' }).status, 'refunded');
});

test('sem transaction_type cai no billing_status, tambem traduzido', () => {
  const semTipo = { ...IPN };
  delete semTipo.transaction_type;
  assert.strictEqual(normalizarDigistore(semTipo).status, 'paid', 'billing_status completed e venda paga');
  assert.strictEqual(normalizarDigistore(semTipo).paid, true);
});

test('estado desconhecido sai em minusculas e nao vira paid', () => {
  const r = normalizarDigistore({ ...IPN, transaction_type: 'Estorno_Parcial' });
  assert.strictEqual(r.status, 'estorno_parcial', 'preserva a evidencia do que chegou');
  assert.strictEqual(r.paid, false, 'nao inventar pagamento a partir de estado que nao sei ler');
});

test('sem transaction_type e sem billing_status o status e null', () => {
  const vazio = { ...IPN };
  delete vazio.transaction_type;
  delete vazio.billing_status;
  assert.strictEqual(normalizarDigistore(vazio).status, null);
  assert.strictEqual(normalizarDigistore(vazio).paid, false);
});

test('teste vem de api_mode', () => {
  assert.strictEqual(normalizarDigistore(IPN).teste, false);
  assert.strictEqual(normalizarDigistore({ ...IPN, api_mode: 'test' }).teste, true);
});

test('junta nome e endereco', () => {
  const v = normalizarDigistore(IPN);
  assert.strictEqual(v.nome, 'Ana Maria');
  assert.strictEqual(v.email, 'a@b.com');
  assert.strictEqual(v.phone, '11988887777');
});

test('mapeia city/state/country dos campos address_*', () => {
  const v = normalizarDigistore(IPN);
  assert.strictEqual(v.city, 'Sao Paulo');
  assert.strictEqual(v.state, 'SP');
  assert.strictEqual(v.country, 'BR');
});

test('origem e digistore24 e nao ha pixelId', () => {
  const v = normalizarDigistore(IPN);
  assert.strictEqual(v.origem, 'digistore24');
  assert.strictEqual(v.pixelId, null);
});

test('sem transaction_id o txId e null, nao o prefixo sozinho', () => {
  const v = normalizarDigistore({ ...IPN, transaction_id: undefined });
  assert.strictEqual(v.txId, null);
});

test('params vazios ou invalidos nao lancam', () => {
  for (const p of [null, undefined, {}, 'texto', []]) {
    const v = normalizarDigistore(p);
    assert.strictEqual(v.origem, 'digistore24');
    assert.strictEqual(v.paid, false);
    assert.strictEqual(v.value, 0);
  }
});
