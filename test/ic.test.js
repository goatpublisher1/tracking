const { test } = require('node:test');
const assert = require('node:assert');
const { enviarIC } = require('../ic');

const click = { sck: 'idx_abc', fbp: 'fb.1.1.2', fbc: null, fbclid: 'CLK', ip: '1.2.3.4',
  user_agent: 'UA', landing_url: 'https://x/vsl', created_at: new Date(1700000000000) };

function fakePool(funnels) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('FROM funnels WHERE active AND domain')) return { rows: funnels };
      return { rows: [] };
    },
  };
}

test('manda um IC por pixel do dominio e grava event_log com event_id = sck', async (t) => {
  const fetchOriginal = global.fetch;
  const corpos = [];
  global.fetch = async (url, opts) => { corpos.push({ url, body: JSON.parse(opts.body) }); return { status: 200, json: async () => ({ events_received: 1 }) }; };
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePool([
    { id: 1, pixel_id: '111', capi_token: 't1', domain: 'www.x.com', active: true },
    { id: 2, pixel_id: '222', capi_token: 't2', domain: 'www.x.com', active: true },
  ]);
  const r = await enviarIC(pool, { dominio: 'www.x.com', click });

  assert.deepStrictEqual(r, { enviados: 2, aceitos: 2 });
  assert.ok(corpos[0].url.includes('/111/events') && corpos[1].url.includes('/222/events'));
  assert.strictEqual(corpos[0].body.data[0].event_name, 'InitiateCheckout');
  assert.strictEqual(corpos[0].body.data[0].event_id, 'idx_abc');
  const logs = pool.calls.filter(c => c.text.includes('INSERT INTO event_log'));
  assert.strictEqual(logs.length, 2);
  assert.strictEqual(logs[0].params[0], 'idx_abc');
  assert.strictEqual(logs[0].params[2], 1);
});

test('Meta fora do ar nao lanca: conta como nao aceito e loga', async (t) => {
  const fetchOriginal = global.fetch;
  global.fetch = async () => { throw new Error('ECONNRESET'); };
  const erroOriginal = console.error; const erros = [];
  console.error = (...a) => erros.push(a.join(' '));
  t.after(() => { global.fetch = fetchOriginal; console.error = erroOriginal; });

  const pool = fakePool([{ id: 1, pixel_id: '111', capi_token: 't1', domain: 'www.x.com', active: true }]);
  const r = await enviarIC(pool, { dominio: 'www.x.com', click });
  assert.deepStrictEqual(r, { enviados: 1, aceitos: 0 });
  assert.ok(erros.some(e => e.includes('CAPI_IC_FALHOU')));
});

test('sem funil ativo no dominio, nao manda nada', async () => {
  const pool = fakePool([]);
  const r = await enviarIC(pool, { dominio: 'www.x.com', click });
  assert.deepStrictEqual(r, { enviados: 0, aceitos: 0 });
});

test('sem sck nao manda nada', async () => {
  const pool = fakePool([{ id: 1, pixel_id: '111', capi_token: 't1' }]);
  const r = await enviarIC(pool, { dominio: 'www.x.com', click: { ...click, sck: null } });
  assert.deepStrictEqual(r, { enviados: 0, aceitos: 0 });
});

test('CAPI_IC_DESLIGADO=1 desliga sem erro', async (t) => {
  process.env.CAPI_IC_DESLIGADO = '1';
  t.after(() => { delete process.env.CAPI_IC_DESLIGADO; });
  const pool = fakePool([{ id: 1, pixel_id: '111', capi_token: 't1' }]);
  const r = await enviarIC(pool, { dominio: 'www.x.com', click });
  assert.deepStrictEqual(r, { enviados: 0, aceitos: 0, desligado: true });
  assert.strictEqual(pool.calls.length, 0);
});
