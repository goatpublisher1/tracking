const { test } = require('node:test');
const assert = require('node:assert');
const { clickIds } = require('../normalize');

test('clickIds devolve os tres campos saneados', () => {
  const r = clickIds({ gclid: 'Cj0KCQ', gbraid: '', wbraid: 'W1' });
  assert.deepStrictEqual(r, { gclid: 'Cj0KCQ', gbraid: null, wbraid: 'W1', ttclid: null });
});

test('clickIds: ausente, nao-string e vazio viram null', () => {
  assert.deepStrictEqual(clickIds({}), { gclid: null, gbraid: null, wbraid: null, ttclid: null });
  assert.deepStrictEqual(clickIds({ gclid: 123, gbraid: {}, wbraid: '   ' }),
    { gclid: null, gbraid: null, wbraid: null, ttclid: null });
  assert.deepStrictEqual(clickIds(null), { gclid: null, gbraid: null, wbraid: null, ttclid: null });
});

test('clickIds corta em 200 caracteres', () => {
  const longo = 'a'.repeat(300);
  assert.strictEqual(clickIds({ gclid: longo }).gclid.length, 200);
});

test('clickIds inclui ttclid, saneado como os do Google', () => {
  const r = clickIds({ gclid: 'G', ttclid: '  E.C.P.abc  ' });
  assert.strictEqual(r.ttclid, 'E.C.P.abc');
  assert.strictEqual(r.gclid, 'G');
  assert.strictEqual(clickIds({}).ttclid, null);
  assert.strictEqual(clickIds({ ttclid: 'x'.repeat(300) }).ttclid.length, 200);
});

test('ttpDe le o cookie _ttp mandado pelo header, ou null', () => {
  const { ttpDe } = require('../normalize');
  assert.strictEqual(ttpDe({ ttp: 'abc123' }), 'abc123');
  assert.strictEqual(ttpDe({ ttp: '' }), null);
  assert.strictEqual(ttpDe({}), null);
  assert.strictEqual(ttpDe({ ttp: 42 }), null);
});
