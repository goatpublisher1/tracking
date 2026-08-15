const { test } = require('node:test');
const assert = require('node:assert');
const { hash, hashPhone } = require('../capi');

test('hash normaliza trim e lowercase antes do sha256', () => {
  assert.strictEqual(hash('  Foo@Bar.COM '), hash('foo@bar.com'));
});

test('hash devolve undefined para vazio', () => {
  assert.strictEqual(hash(''), undefined);
  assert.strictEqual(hash(null), undefined);
});

test('hashPhone remove nao-digitos', () => {
  assert.strictEqual(hashPhone('(11) 98888-7777'), hash('11988887777'));
});
