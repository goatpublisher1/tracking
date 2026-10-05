const { test } = require('node:test');
const assert = require('node:assert');
const { enviarIC, enviarICTikTok } = require('../ic');

const click = { sck: 'idx_abc', fbp: 'fb.1.1.2', fbc: null, fbclid: 'CLK', ip: '1.2.3.4',
  user_agent: 'UA', landing_url: 'https://x/vsl', created_at: new Date(1700000000000) };

function fakePool(funnels, tiktokRows = []) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('FROM funnels WHERE active AND domain')) return { rows: funnels };
      if (text.includes('FROM tiktok_pixels')) return { rows: tiktokRows };
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

test('IC TikTok: um por pixel do dominio, event_id = sck, plataforma tiktok', async (t) => {
  const fetchOriginal = global.fetch; const corpos = [];
  global.fetch = async (url, opts) => { corpos.push({ url, body: JSON.parse(opts.body) }); return { status: 200, json: async () => ({ code: 0 }) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  const pool = fakePool([], [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }, { id: 2, pixel_code: 'CA2', access_token: 'k2' }]);
  const r = await enviarICTikTok(pool, { dominio: 'www.x.com', funnelId: 7, click: { ...click, ttclid: 'E.C.P.x', ttp: 't1' } });
  assert.deepStrictEqual(r, { enviados: 2, aceitos: 2 });
  assert.ok(corpos.every(c => c.url.includes('business-api.tiktok.com')));
  assert.strictEqual(corpos[0].body.data[0].event_id, 'idx_abc');
  const logs = pool.calls.filter(c => c.text.includes('INSERT INTO event_log'));
  assert.strictEqual(logs.length, 2);
  assert.ok(logs[0].text.includes("'tiktok'"));
  assert.strictEqual(logs[0].params[2], 7);
});

test('IC TikTok: TIKTOK_EVENTS_DESLIGADO=1 desliga; sem pixel nao manda', async (t) => {
  process.env.TIKTOK_EVENTS_DESLIGADO = '1';
  t.after(() => { delete process.env.TIKTOK_EVENTS_DESLIGADO; });
  const pool = fakePool([], [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }]);
  assert.deepStrictEqual(await enviarICTikTok(pool, { dominio: 'www.x.com', funnelId: 7, click }), { enviados: 0, aceitos: 0, desligado: true });
  delete process.env.TIKTOK_EVENTS_DESLIGADO;
  assert.deepStrictEqual(await enviarICTikTok(fakePool([], []), { dominio: 'www.x.com', funnelId: 7, click }), { enviados: 0, aceitos: 0 });
});

test('IC TikTok: rejeicao (HTTP 200 + code != 0) nao conta como aceito e grava status 0', async (t) => {
  const fetchOriginal = global.fetch; const erroOriginal = console.error;
  global.fetch = async () => ({ status: 200, json: async () => ({ code: 40002, message: 'bad' }) });
  console.error = () => {};
  t.after(() => { global.fetch = fetchOriginal; console.error = erroOriginal; });
  const pool = fakePool([], [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }]);
  const r = await enviarICTikTok(pool, { dominio: 'www.x.com', funnelId: 7, click });
  assert.deepStrictEqual(r, { enviados: 1, aceitos: 0 });
  const log = pool.calls.find(c => c.text.includes('INSERT INTO event_log'));
  assert.strictEqual(log.params[3], 0);
});
