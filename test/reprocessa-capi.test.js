const { test } = require('node:test');
const assert = require('node:assert');
const { pixelsComSucesso, resultadosAnteriores } = require('../scripts/reprocessa-capi');

test('pixels com 200 ficam de fora do reenvio; as outras entram', () => {
  const resp = JSON.stringify([{ pixel: '111', status: 200 }, { pixel: '222', status: 500 }]);
  assert.deepStrictEqual([...pixelsComSucesso(resp)], ['111']);
  assert.strictEqual(resultadosAnteriores(resp).length, 2);
});

test('capi_response nulo, pulado ou quebrado conta como nenhuma pixel recebeu', () => {
  for (const v of [null, undefined, '{"skipped":"modo_teste"}', 'lixo', { skipped: 'x' }]) {
    assert.strictEqual(pixelsComSucesso(v).size, 0);
    assert.deepStrictEqual(resultadosAnteriores(v), []);
  }
});
