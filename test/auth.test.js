const { test } = require('node:test');
const assert = require('node:assert');
const { tokenValido } = require('../auth');

test('aceita token identico', () => {
  assert.strictEqual(tokenValido('abc123', 'abc123'), true);
});

test('rejeita token diferente do mesmo tamanho', () => {
  assert.strictEqual(tokenValido('abc123', 'abc124'), false);
});

test('rejeita tamanhos diferentes sem lancar', () => {
  assert.strictEqual(tokenValido('abc', 'abc123'), false);
});

test('rejeita vazio, null e undefined dos dois lados', () => {
  assert.strictEqual(tokenValido('', 'abc123'), false);
  assert.strictEqual(tokenValido('abc123', ''), false);
  assert.strictEqual(tokenValido(null, 'abc123'), false);
  assert.strictEqual(tokenValido('abc123', undefined), false);
});
