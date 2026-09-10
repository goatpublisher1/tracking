const { test } = require('node:test');
const assert = require('node:assert');
const { clickIds } = require('../normalize');

test('clickIds devolve os tres campos saneados', () => {
  const r = clickIds({ gclid: 'Cj0KCQ', gbraid: '', wbraid: 'W1' });
  assert.deepStrictEqual(r, { gclid: 'Cj0KCQ', gbraid: null, wbraid: 'W1' });
});

test('clickIds: ausente, nao-string e vazio viram null', () => {
  assert.deepStrictEqual(clickIds({}), { gclid: null, gbraid: null, wbraid: null });
  assert.deepStrictEqual(clickIds({ gclid: 123, gbraid: {}, wbraid: '   ' }),
    { gclid: null, gbraid: null, wbraid: null });
  assert.deepStrictEqual(clickIds(null), { gclid: null, gbraid: null, wbraid: null });
});

test('clickIds corta em 200 caracteres', () => {
  const longo = 'a'.repeat(300);
  assert.strictEqual(clickIds({ gclid: longo }).gclid.length, 200);
});
