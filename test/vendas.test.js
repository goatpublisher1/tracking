const { test } = require('node:test');
const assert = require('node:assert');
const { processarVenda, SQL_HERDA_FUNIL_VENDA } = require('../vendas');

// Pool falso: sem funil resolvido e sem venda paga, o fluxo termina logo apos
// o INSERT INTO sales — o suficiente para inspecionar os parametros gravados
// sem tocar CAPI nem Postgres de verdade.
function fakePool({ storeRow = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('SELECT * FROM store WHERE sck=$1')) return { rows: storeRow ? [storeRow] : [] };
      if (text.includes('FROM clicks WHERE sck=$1')) return { rows: [] };
      // funnels/products: nunca resolve funil (mantem o teste fora do caminho de CAPI)
      return { rows: [] };
    },
  };
}

function insertSalesArgs(calls) {
  const c = calls.find(c => c.text.includes('INSERT INTO sales'));
  return c.params;
}

test('src cai para store.src quando venda.src vem null (Digistore24)', async () => {
  const pool = fakePool({ storeRow: { src: 'fb_utm_123' } });
  const venda = { txId: 'ds24_T1', sck: 'idx_abc', src: null, paid: false, value: 0, total: 0, origem: 'digistore24' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[3], 'fb_utm_123');
});

test('venda.src da propria plataforma continua vencendo (PayT nao regride)', async () => {
  const pool = fakePool({ storeRow: { src: 'store_value_ignorado' } });
  const venda = { txId: 'T2', sck: 'idx_abc', src: 'fb1', paid: false, value: 0, total: 0, origem: 'payt' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[3], 'fb1');
});

test('sem venda.src e sem store (ou sem sck), src grava null', async () => {
  const pool = fakePool();
  const venda = { txId: 'T3', sck: null, src: null, paid: false, value: 0, total: 0, origem: 'digistore24' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[3], null);
});

// Pool falso que resolve um funil (via store.funnel_id) e paga a venda, para exercitar
// o INSERT INTO event_log — que so acontece depois de um Purchase enviado com sucesso.
// `antes`: a linha de sales antes do webhook; `retorno`: o que o upsert devolve (RETURNING status).
function fakePoolComFunil({ storeRow, clickRow, tiktokRows = [], produtoRow = null, antes = null, retorno = null }) {
  const calls = [];
  const funnelRow = { id: 1, slug: 'x-fb1', domain: 'x.com', pixel_id: '123', capi_token: 'tok', currency: 'BRL', active: true };
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('SELECT status, capi_sent')) return { rows: antes ? [antes] : [] };
      if (text.includes('INSERT INTO sales')) return { rows: retorno ? [retorno] : [] };
      if (text.includes('SELECT funnel_id FROM store WHERE sck=$1')) return { rows: [{ funnel_id: 1 }] };
      if (text.includes('SELECT * FROM funnels WHERE id=$1')) return { rows: [funnelRow] };
      if (text.includes('SELECT * FROM funnels WHERE active AND domain')) return { rows: [funnelRow] };
      if (text.includes('WHERE active AND slug = $1')) return { rows: [funnelRow] };
      if (text.includes('FROM tiktok_pixels')) return { rows: tiktokRows };
      if (text.includes('FROM products pr')) return { rows: produtoRow ? [produtoRow] : [] };
      if (text.includes('SELECT * FROM store WHERE sck=$1')) return { rows: [storeRow] };
      if (text.includes('FROM clicks WHERE sck=$1')) return { rows: clickRow ? [clickRow] : [] };
      return { rows: [] };
    },
  };
}

test('event_log.src usa o mesmo fallback que sales.src (Digistore24 sem venda.src)', async (t) => {
  const fetchOriginal = global.fetch;
  global.fetch = async () => ({ status: 200, json: async () => ({}) });
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePoolComFunil({ storeRow: { src: 'fb_utm_123' } });
  const venda = { txId: 'ds24_T4', sck: 'idx_abc', src: null, paid: true, status: 'paid', value: 10, total: 10, origem: 'digistore24' };
  await processarVenda(pool, venda);

  const eventLog = pool.calls.find(c => c.text.includes('INSERT INTO event_log'));
  assert.ok(eventLog, 'event_log deveria ter sido gravado');
  assert.strictEqual(eventLog.params[1], 'fb_utm_123');
});

test('o Purchase leva sck, geo e ip da venda e o clique com fbclid', async (t) => {
  const fetchOriginal = global.fetch;
  let corpo = null;
  global.fetch = async (_url, opts) => { corpo = JSON.parse(opts.body); return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePoolComFunil({
    storeRow: { src: 'fb', fbp: 'fb.1.1.2' },
    clickRow: { sck: 'idx_abc', fbclid: 'CLK', created_at: new Date(1700000000000), ip: '5.5.5.5', user_agent: 'UA' },
  });
  const venda = { txId: 'T5', sck: 'idx_abc', src: 'fb', paid: true, status: 'paid', value: 10, total: 10, origem: 'digistore24',
    email: 'a@b.com', city: 'Austin', state: 'TX', country: 'United States', ip: null };
  await processarVenda(pool, venda);

  const ud = corpo.data[0].user_data;
  assert.ok(ud.external_id, 'external_id (hash do sck) deveria ir');
  assert.strictEqual(ud.fbc, 'fb.1.1700000000000.CLK');
  assert.ok(ud.country, 'country deveria ir (United States -> us)');
  assert.ok(ud.ct && ud.st, 'cidade e estado deveriam ir');
  assert.strictEqual(ud.client_ip_address, '5.5.5.5');
});

test('Purchase que falha (fetch lanca) grava event_log com http_status 0 e a funcao resolve', async (t) => {
  const fetchOriginal = global.fetch;
  global.fetch = async () => { throw new Error('timeout'); };
  t.after(() => { global.fetch = fetchOriginal; });
  const errOriginal = console.error;
  console.error = () => {};
  t.after(() => { console.error = errOriginal; });

  const pool = fakePoolComFunil({ storeRow: { src: 'fb' } });
  const venda = { txId: 'T6', sck: 'idx_abc', src: 'fb', paid: true, status: 'paid', value: 10, total: 10, origem: 'digistore24' };
  const r = await processarVenda(pool, venda);
  assert.strictEqual(r.ok, true);
  const eventLog = pool.calls.find(c => c.text.includes('INSERT INTO event_log'));
  assert.ok(eventLog, 'event_log deveria ter a linha da falha');
  assert.strictEqual(eventLog.params[3], 0);
  assert.strictEqual(eventLog.params[4], null);
});

// Pool falso que resolve funil por SLUG, o caminho do postback de afiliado.
function fakePoolComSlug() {
  const calls = [];
  const funnelRow = { id: 7, slug: 'chemistrysystem-fb1', domain: 'www.chemistrysystem.com',
    pixel_id: '999', capi_token: 'tok', currency: 'USD', active: true };
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('WHERE active AND slug = $1')) return { rows: [funnelRow] };
      if (text.includes('SELECT * FROM funnels WHERE active AND domain')) return { rows: [funnelRow] };
      return { rows: [] };
    },
  };
}

test('funnelSlug resolve o funil sem sck e sem produto cadastrado', async () => {
  const pool = fakePoolComSlug();
  const venda = { txId: 'ds24a_1', funnelSlug: 'chemistrysystem-fb1', sck: null, src: null,
    paid: false, value: 51, total: 97, origem: 'digistore24_afiliado' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[17], 7, 'funnel_id deveria ser o do funil achado pelo slug');
  assert.strictEqual(args[7], 'USD', 'a moeda vem do funil resolvido');
});

test('enviarMeta false nao chama a Meta mesmo com venda paga e funil resolvido', async (t) => {
  const fetchOriginal = global.fetch;
  let chamou = false;
  global.fetch = async () => { chamou = true; return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePoolComSlug();
  const venda = { txId: 'ds24a_2', funnelSlug: 'chemistrysystem-fb1', sck: null, src: null,
    paid: true, status: 'paid', value: 51, total: 97, enviarMeta: false, origem: 'digistore24_afiliado' };
  const r = await processarVenda(pool, venda);
  assert.strictEqual(chamou, false, 'a CAPI nao podia ter sido chamada');
  assert.strictEqual(r.motivo, 'produto_nao_envia_meta');
});

test('offerType da venda e gravado quando nao ha produto cadastrado', async () => {
  const pool = fakePoolComSlug();
  const venda = { txId: 'ds24a_3', funnelSlug: 'chemistrysystem-fb1', sck: null, src: null,
    paid: false, value: 51, total: 97, offerType: 'backend', origem: 'digistore24_afiliado' };
  await processarVenda(pool, venda);
  assert.strictEqual(insertSalesArgs(pool.calls)[18], 'backend');
});

test('venda sem os campos novos se comporta como antes (PayT nao regride)', async () => {
  const pool = fakePool();
  const venda = { txId: 'T10', sck: 'idx_x', src: 'fb1', paid: false, value: 100, total: 100,
    origem: 'payt' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[17], null, 'sem funil resolvido, funnel_id segue null');
  assert.strictEqual(args[18], null, 'sem produto cadastrado, offer_type segue null');
  // e nenhuma consulta por slug foi feita
  assert.ok(!pool.calls.some(c => c.text.includes('WHERE active AND slug = $1')));
});

// ---- auditoria 2026-09-11: sem fallback para pixel desativado, e teste sem CAPI

test('dominio sem funil ativo nao dispara CAPI para o funil desativado (T07)', async (t) => {
  const capi = require('../capi');
  let chamadas = 0;
  t.mock.method(capi, 'sendPurchase', async () => { chamadas++; return { httpStatus: 200, response: {}, payload: {} }; });
  const desativado = { id: 1, slug: 'velho', domain: 'x.com', pixel_id: '1', capi_token: 't', currency: 'BRL', active: false };
  const calls = [];
  const pool = { calls, async query(text, params) {
    calls.push({ text, params });
    if (text === 'SELECT funnel_id FROM store WHERE sck=$1') return { rows: [{ funnel_id: 1 }] };
    if (text === 'SELECT * FROM funnels WHERE id=$1') return { rows: [desativado] };
    if (text.includes('SELECT * FROM funnels WHERE active AND domain')) return { rows: [] };
    return { rows: [] };
  } };
  const r = await processarVenda(pool, { txId: 't7', sck: 'idx_1', paid: true, status: 'paid', value: 10 });
  assert.strictEqual(chamadas, 0);
  assert.strictEqual(r.motivo, 'funnel_nao_resolvido');
  // a venda continua gravada com o funil desativado (atribuicao)
  assert.strictEqual(insertSalesArgs(calls)[17], 1);
});

test('venda de teste grava o marcador e nunca chama a Meta, mesmo com funil e pixel ativos', async (t) => {
  const capi = require('../capi');
  let chamadas = 0;
  t.mock.method(capi, 'sendPurchase', async () => { chamadas++; return { httpStatus: 200, response: {}, payload: {} }; });
  const funnelRow = { id: 1, slug: 'f', domain: 'x.com', pixel_id: '1', capi_token: 't', currency: 'BRL', active: true };
  const calls = [];
  const pool = { calls, async query(text, params) {
    calls.push({ text, params });
    if (text.includes('WHERE active AND slug = $1')) return { rows: [funnelRow] };
    if (text.includes('SELECT * FROM funnels WHERE active AND domain')) return { rows: [funnelRow] };
    return { rows: [] };
  } };
  const r = await processarVenda(pool, { txId: 't5', funnelSlug: 'f', paid: false, teste: true, status: 'test', value: 10 });
  assert.strictEqual(chamadas, 0);
  assert.strictEqual(r.motivo, 'teste');
  assert.strictEqual(insertSalesArgs(calls)[4], 'test');
  assert.ok(calls.some(c => c.text.includes('SET capi_response') && c.params[0].includes('modo_teste')));
});

// Substitui o teste antigo das duas transicoes proibidas: a regra de posto cobre as duas e
// tambem paid -> canceled/expired e refunded -> refused, que passavam.
test('status so anda para frente: posto paid 1, refunded/chargeback 2, resto 0; test nunca sobrescreve status real', async () => {
  const pool = fakePool();
  await processarVenda(pool, { txId: 'tx', status: 'paid', paid: true, value: 1 });
  const sql = pool.calls.find(c => c.text.includes('INSERT INTO sales')).text;
  assert.ok(/CASE WHEN EXCLUDED\.status = 'paid' THEN 1 WHEN EXCLUDED\.status IN \('refunded','chargeback'\) THEN 2 ELSE 0 END\)\s*<\s*\(CASE WHEN sales\.status = 'paid' THEN 1 WHEN sales\.status IN \('refunded','chargeback'\) THEN 2 ELSE 0 END\)\s*THEN sales\.status/.test(sql));
  assert.ok(/WHEN EXCLUDED\.status = 'test' THEN COALESCE\(sales\.status, EXCLUDED\.status\)/.test(sql));
  assert.ok(/RETURNING status/.test(sql));
});

test('refunded_at e gravado quando a venda vira refunded/chargeback, e so na primeira vez', async () => {
  const pool = fakePool();
  await processarVenda(pool, { txId: 'r1', status: 'refunded', paid: false, value: 1 });
  const sql = pool.calls.find(c => c.text.includes('INSERT INTO sales')).text;
  assert.ok(/CASE WHEN \$5 IN \('refunded','chargeback'\) THEN now\(\) END/.test(sql));
  assert.ok(/WHEN sales\.refunded_at IS NULL AND EXCLUDED\.status IN \('refunded','chargeback'\) THEN now\(\)/.test(sql));
  assert.ok(/ELSE sales\.refunded_at END/.test(sql));
});

// ---- TikTok: CompletePayment para os pixels TikTok do dominio ----
// Produto cadastrado com send_to_tiktok=true (produto nao cadastrado nao vai para a TikTok).
const produtoTikTok = { offer_type: 'principal', send_to_meta: true, send_to_tiktok: true, id: 1, slug: 'x-fb1', domain: 'x.com', pixel_id: '123', capi_token: 'tok', currency: 'BRL', active: true };

test('venda paga vai para cada pixel TikTok do dominio, com plataforma tiktok no event_log', async (t) => {
  const fetchOriginal = global.fetch; const urls = [];
  global.fetch = async (url, opts) => { urls.push({ url, body: JSON.parse(opts.body) }); return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePoolComFunil({
    storeRow: { src: 'tt', fbp: 'fb.1.1.2' },
    clickRow: { sck: 'idx_abc', ttclid: 'E.C.P.x', ttp: 't1', ip: '5.5.5.5', user_agent: 'UA', created_at: new Date() },
    tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1', domain: 'x.com', active: true },
                 { id: 2, pixel_code: 'CA2', access_token: 'k2', domain: 'x.com', active: true }],
    produtoRow: produtoTikTok,
  });
  const venda = { txId: 'T7', sck: 'idx_abc', src: 'tt', paid: true, status: 'paid', value: 50, total: 50, origem: 'payt', email: 'a@b.com', productCode: 'P1' };
  const r = await processarVenda(pool, venda);
  assert.strictEqual(r.ok, true);

  const tiktok = urls.filter(u => u.url.includes('business-api.tiktok.com'));
  assert.strictEqual(tiktok.length, 2);
  assert.deepStrictEqual(tiktok.map(u => u.body.event_source_id).sort(), ['CA1', 'CA2']);
  assert.strictEqual(tiktok[0].body.data[0].event, 'CompletePayment');
  assert.strictEqual(tiktok[0].body.data[0].event_id, 'purchase_T7');
  assert.strictEqual(tiktok[0].body.data[0].user.ttclid, 'E.C.P.x');

  const logs = pool.calls.filter(c => c.text.includes('INSERT INTO event_log'));
  const tt = logs.filter(c => c.text.includes("'tiktok'"));
  const meta = logs.filter(c => c.text.includes("'meta'"));
  assert.strictEqual(tt.length, 2);
  assert.strictEqual(meta.length, 1);
  assert.strictEqual(tt[0].params[0], 'purchase_T7');
});

test('produto com send_to_tiktok=false nao vai para a TikTok (mas vai para a Meta)', async (t) => {
  const fetchOriginal = global.fetch; const urls = [];
  global.fetch = async (url) => { urls.push(url); return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  const pool = fakePoolComFunil({
    storeRow: { src: 'x' }, clickRow: { sck: 'idx_abc', user_agent: 'UA', ip: '1.1.1.1', created_at: new Date() },
    tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }],
    produtoRow: { ...produtoTikTok, send_to_tiktok: false },
  });
  await processarVenda(pool, { txId: 'T8', sck: 'idx_abc', paid: true, status: 'paid', value: 10, total: 10, origem: 'payt', productCode: 'P1' });
  assert.ok(urls.some(u => u.includes('graph.facebook.com')));
  assert.ok(!urls.some(u => u.includes('business-api.tiktok.com')));
});

test('TikTok fora do ar nao derruba a venda nem a Meta; event_log com status 0', async (t) => {
  const fetchOriginal = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('tiktok')) throw new Error('ECONNRESET');
    return { status: 200, json: async () => ({}) };
  };
  const erroOriginal = console.error; const erros = [];
  console.error = (...a) => erros.push(a.join(' '));
  t.after(() => { global.fetch = fetchOriginal; console.error = erroOriginal; });
  const pool = fakePoolComFunil({
    storeRow: { src: 'x' }, clickRow: { sck: 'idx_abc', user_agent: 'UA', ip: '1.1.1.1', created_at: new Date() },
    tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }],
    produtoRow: produtoTikTok,
  });
  const r = await processarVenda(pool, { txId: 'T9', sck: 'idx_abc', paid: true, status: 'paid', value: 10, total: 10, origem: 'payt', productCode: 'P1' });
  assert.strictEqual(r.ok, true);
  const tt = pool.calls.filter(c => c.text.includes('INSERT INTO event_log') && c.text.includes("'tiktok'"));
  assert.strictEqual(tt.length, 1);
  assert.strictEqual(tt[0].params[3], 0);
  assert.ok(erros.some(e => e.includes('TIKTOK_FALHOU')));
});

test('venda de afiliado (enviarMeta false) tambem nao vai para a TikTok', async (t) => {
  const fetchOriginal = global.fetch; const urls = [];
  global.fetch = async (url) => { urls.push(url); return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  const pool = fakePoolComFunil({ storeRow: null, clickRow: null, tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }], produtoRow: produtoTikTok });
  await processarVenda(pool, { txId: 'ds24a_1', funnelSlug: 'x-fb1', sck: null, paid: true, status: 'paid', value: 10, total: 10, enviarMeta: false, origem: 'digistore24_afiliado', productCode: 'P1' });
  assert.strictEqual(urls.length, 0);
});

test('produto nao cadastrado nao vai para a TikTok, mesmo com pixels no dominio', async (t) => {
  const fetchOriginal = global.fetch; const urls = [];
  global.fetch = async (url) => { urls.push(url); return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  for (const productCode of [undefined, 'NAOCADASTRADO']) {
    const pool = fakePoolComFunil({
      storeRow: { src: 'x' }, clickRow: { sck: 'idx_abc', user_agent: 'UA', ip: '1.1.1.1', created_at: new Date() },
      tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }],
    });
    await processarVenda(pool, { txId: 'T10', sck: 'idx_abc', paid: true, status: 'paid', value: 10, total: 10, origem: 'payt', productCode });
  }
  assert.ok(urls.some(u => u.includes('graph.facebook.com')));
  assert.ok(!urls.some(u => u.includes('business-api.tiktok.com')));
});

test('TikTok rejeita com HTTP 200 e code != 0: event_log grava status 0', async (t) => {
  const fetchOriginal = global.fetch;
  global.fetch = async (url) => url.includes('tiktok')
    ? { status: 200, json: async () => ({ code: 40001, message: 'bad token' }) }
    : { status: 200, json: async () => ({}) };
  const erroOriginal = console.error; const erros = [];
  console.error = (...a) => erros.push(a.join(' '));
  t.after(() => { global.fetch = fetchOriginal; console.error = erroOriginal; });
  const pool = fakePoolComFunil({
    storeRow: { src: 'x' }, clickRow: { sck: 'idx_abc', user_agent: 'UA', ip: '1.1.1.1', created_at: new Date() },
    tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }],
    produtoRow: produtoTikTok,
  });
  await processarVenda(pool, { txId: 'T11', sck: 'idx_abc', paid: true, status: 'paid', value: 10, total: 10, origem: 'payt', productCode: 'P1' });
  const tt = pool.calls.filter(c => c.text.includes('INSERT INTO event_log') && c.text.includes("'tiktok'"));
  assert.strictEqual(tt.length, 1);
  assert.strictEqual(tt[0].params[3], 0);
  assert.ok(erros.some(e => e.includes('TIKTOK_FALHOU') && e.includes('40001')));
});

test('dominio ativo sem pixel: grava a venda, nao chama a Meta, marca sem_pixel e loga CAPI_SEM_PIXEL', async (t) => {
  const capi = require('../capi');
  let chamadas = 0;
  t.mock.method(capi, 'sendPurchase', async () => { chamadas++; return { httpStatus: 200, response: {}, payload: {} }; });
  const erroOriginal = console.error; const erros = [];
  console.error = (...a) => erros.push(a.join(' '));
  t.after(() => { console.error = erroOriginal; });
  const semPixel = { id: 1, slug: 'novo-1', domain: 'x.com', pixel_id: null, capi_token: null, currency: 'BRL', active: true };
  const calls = [];
  const pool = { calls, async query(text, params) {
    calls.push({ text, params });
    if (text === 'SELECT funnel_id FROM store WHERE sck=$1') return { rows: [{ funnel_id: 1 }] };
    if (text === 'SELECT * FROM funnels WHERE id=$1') return { rows: [semPixel] };
    if (text.includes('SELECT * FROM funnels WHERE active AND domain')) return { rows: [semPixel] };
    return { rows: [] };
  } };
  const r = await processarVenda(pool, { txId: 't8', sck: 'idx_1', paid: true, status: 'paid', value: 10 });
  assert.strictEqual(chamadas, 0);
  assert.strictEqual(r.motivo, 'sem_pixel');
  assert.strictEqual(insertSalesArgs(calls)[17], 1);
  const upd = calls.find(c => c.text.includes('UPDATE sales SET capi_response'));
  assert.strictEqual(upd.params[0], '{"skipped":"sem_pixel"}');
  assert.ok(erros.some(e => e.includes('CAPI_SEM_PIXEL')));
});

test('sem clique pelo sck, a venda usa os utm_* que a PayT recebeu para atribuir a campanha', async () => {
  const pool = fakePool();
  const venda = { txId: 'T9', sck: 'idx_sem_clique', src: null, paid: false, value: 0, total: 0, origem: 'payt',
    utms: { utm_source: 'ig', utm_medium: 'paid', utm_campaign: '120257057544780768', utm_term: '120257057544760768', utm_content: '120257057578940768::x::' } };
  await processarVenda(pool, venda);
  const a = insertSalesArgs(pool.calls);
  assert.deepStrictEqual(a.slice(12, 17), ['FB', null, '120257057544780768', '120257057544760768', '120257057578940768']);
});

// Inverte o teste antigo "clique com campanha continua vencendo os utm_* da PayT": a URL do
// checkout e o anuncio que trouxe ESTA compra; o clique do mesmo sck pode ser de dias antes,
// de outra campanha.
test('utm_* da URL do checkout com campanha vencem clique antigo de outra campanha', async () => {
  const calls = [];
  const clique = { sck: 'idx_c', utm_source: 'FB', utm_campaign: 'Camp', campaign_id: 'C1', adset_id: 'S1', ad_id: 'A1' };
  const pool = { calls, async query(text, params) {
    calls.push({ text, params });
    if (text.includes('FROM clicks WHERE sck=$1')) return { rows: [clique] };
    return { rows: [] };
  } };
  await processarVenda(pool, { txId: 'T10', sck: 'idx_c', paid: false, value: 0, total: 0, origem: 'payt',
    utms: { utm_source: 'FB', utm_campaign: 'Outra|999999' } });
  assert.deepStrictEqual(insertSalesArgs(calls).slice(12, 17), ['FB', 'Outra', '999999', null, null]);
});

test('utm_* malformado da PayT (% solto) nunca impede a venda de ser gravada', async () => {
  const pool = fakePool();
  const avisoOriginal = console.warn; console.warn = () => {};
  try {
    await processarVenda(pool, { txId: 'T11', sck: null, paid: false, value: 0, total: 0, origem: 'payt',
      utms: { utm_source: 'FB', utm_campaign: '50% off|%E0%A4%A' } });
  } finally { console.warn = avisoOriginal; }
  const a = insertSalesArgs(pool.calls);
  assert.ok(a, 'INSERT INTO sales aconteceu');
  assert.ok(a[14] == null, "sem campanha");
});

// ---- auditoria 2026-10-14: venda-mae, clique com campanha, utm_url, Purchase so na transicao

test('upsell sem sck nem utms herda o sck, a campanha e o funil da venda-mae', async () => {
  const calls = [];
  const mae = { sck: 'idx_pai', utm_source: 'FB', utm_campaign: 'Camp', campaign_id: '111111', adset_id: '222222', ad_id: '333333', funnel_id: 1 };
  const funil = { id: 1, slug: 'x-fb1', domain: 'x.com', currency: 'BRL', active: true };
  const pool = { calls, async query(text, params) {
    calls.push({ text, params });
    if (text.includes('upsell_from = $2')) return { rows: [mae] };
    if (text.includes('SELECT * FROM funnels WHERE id=$1')) return { rows: [funil] };
    return { rows: [] };
  } };
  await processarVenda(pool, { txId: 'UP1', sck: null, upsellFrom: 'PAI1', paid: false, status: 'waiting_payment',
    value: 0, total: 0, origem: 'payt' });
  const a = insertSalesArgs(calls);
  assert.strictEqual(a[2], 'idx_pai');
  assert.deepStrictEqual(a.slice(12, 17), ['FB', 'Camp', '111111', '222222', '333333']);
  assert.strictEqual(a[17], 1, 'sem funil pelo store, vale o funil da mae');
  assert.deepStrictEqual(calls.find(c => c.text.includes('upsell_from = $2')).params, ['UP1', 'PAI1']);
});

test('clique com campanha vence clique mais novo sem campanha do mesmo sck', async () => {
  const calls = [];
  const recente = { sck: 'idx_c', utm_source: 'ig', campaign_id: null, user_agent: 'UA' };
  const comCampanha = { sck: 'idx_c', utm_source: 'FB', utm_campaign: 'C', campaign_id: '444444', adset_id: '555555', ad_id: '666666' };
  const pool = { calls, async query(text, params) {
    calls.push({ text, params });
    if (text.includes('FROM clicks') && text.includes('campaign_id IS NOT NULL')) return { rows: [comCampanha] };
    if (text.includes('FROM clicks WHERE sck=$1')) return { rows: [recente] };
    return { rows: [] };
  } };
  await processarVenda(pool, { txId: 'T30', sck: 'idx_c', paid: false, status: 'pending', value: 0, total: 0, origem: 'payt' });
  assert.deepStrictEqual(insertSalesArgs(calls).slice(12, 17), ['FB', 'C', '444444', '555555', '666666']);
});

test('utm_url grava o JSON dos utm_* do checkout; sem utms, null', async () => {
  const utms = { utm_source: 'FB', utm_campaign: 'Camp|123456' };
  const com = fakePool();
  await processarVenda(com, { txId: 'T31', sck: null, paid: false, status: 'pending', value: 0, total: 0, origem: 'payt', utms });
  assert.strictEqual(insertSalesArgs(com.calls)[27], JSON.stringify(utms));
  const sem = fakePool();
  await processarVenda(sem, { txId: 'T32', sck: null, paid: false, status: 'pending', value: 0, total: 0, origem: 'digistore24' });
  assert.strictEqual(insertSalesArgs(sem.calls)[27], null);
});

test('pago_em: hora do servidor na primeira vez que a venda fica paid, nunca depois do reembolso', async () => {
  const pool = fakePool();
  await processarVenda(pool, { txId: 'T33', status: 'paid', paid: true, value: 1 });
  const sql = pool.calls.find(c => c.text.includes('INSERT INTO sales')).text;
  assert.ok(/CASE WHEN \$5 = 'paid' THEN now\(\) END/.test(sql));
  assert.ok(/pago_em = CASE\s+WHEN sales\.pago_em IS NULL AND EXCLUDED\.status = 'paid'\s+AND COALESCE\(sales\.status, ''\) NOT IN \('paid','refunded','chargeback'\) THEN now\(\)\s+ELSE sales\.pago_em END/.test(sql));
  assert.ok(/utm_url = COALESCE\(sales\.utm_url, EXCLUDED\.utm_url\)/.test(sql));
});

test('Purchase so na transicao: venda ja paga e ja enviada nao reenvia (nem TikTok)', async (t) => {
  const fetchOriginal = global.fetch; let chamadas = 0;
  global.fetch = async () => { chamadas++; return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  const pool = fakePoolComFunil({
    storeRow: { src: 'fb' }, clickRow: null,
    tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }], produtoRow: produtoTikTok,
    antes: { status: 'paid', capi_sent: true },
  });
  const r = await processarVenda(pool, { txId: 'T34', sck: 'idx_abc', paid: true, status: 'paid', value: 10, total: 10, origem: 'payt', productCode: 'P1' });
  assert.strictEqual(chamadas, 0, 'nenhuma chamada a Meta nem a TikTok');
  assert.strictEqual(r.motivo, 'ja_enviada');
  assert.ok(!pool.calls.some(c => c.text.includes('capi_response')), 'capi_response da primeira vez fica intacto');
  assert.ok(insertSalesArgs(pool.calls), 'a venda continua gravada');
});

test('paid gravado com capi_sent falso reenvia o Purchase, mas nao o CompletePayment', async (t) => {
  const fetchOriginal = global.fetch; const urls = [];
  global.fetch = async (url) => { urls.push(url); return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  const pool = fakePoolComFunil({
    storeRow: { src: 'fb' }, clickRow: null,
    tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }], produtoRow: produtoTikTok,
    antes: { status: 'paid', capi_sent: false },
  });
  await processarVenda(pool, { txId: 'T35', sck: 'idx_abc', paid: true, status: 'paid', value: 10, total: 10, origem: 'payt', productCode: 'P1' });
  assert.ok(urls.some(u => u.includes('graph.facebook.com')));
  assert.ok(!urls.some(u => u.includes('business-api.tiktok.com')));
});

test('paid depois de reembolso nao vira Purchase: o banco ficou com refunded', async (t) => {
  const fetchOriginal = global.fetch; let chamadas = 0;
  global.fetch = async () => { chamadas++; return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  const pool = fakePoolComFunil({
    storeRow: { src: 'fb' }, clickRow: null,
    tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }], produtoRow: produtoTikTok,
    antes: { status: 'refunded', capi_sent: true }, retorno: { status: 'refunded' },
  });
  const r = await processarVenda(pool, { txId: 'T36', sck: 'idx_abc', paid: true, status: 'paid', value: 10, total: 10, origem: 'payt', productCode: 'P1' });
  assert.strictEqual(chamadas, 0);
  assert.strictEqual(r.motivo, 'status_refunded');
});

test('produto de funil inativo continua valendo: a consulta nao exige f.active e prefere o ativo', async () => {
  const pool = fakePool();
  await processarVenda(pool, { txId: 'T37', sck: null, paid: false, status: 'pending', value: 0, total: 0, origem: 'payt', productCode: 'P1' });
  const q = pool.calls.find(c => c.text.includes('FROM products pr')).text;
  assert.ok(!q.includes('AND f.active'));
  assert.ok(/ORDER BY f\.active DESC NULLS LAST, f\.id LIMIT 1/.test(q), 'f.id desempata');
  assert.ok(/ORDER BY p\.product_code, f\.active DESC NULLS LAST, f\.id\)/.test(SQL_HERDA_FUNIL_VENDA), 'backfill desempata igual');
});

test('leituras novas que falham (mae, clique com campanha, estado anterior) nunca impedem a venda', async (t) => {
  const fetchOriginal = global.fetch; const urls = [];
  global.fetch = async (url) => { urls.push(url); return { status: 200, json: async () => ({}) }; };
  const avisoOriginal = console.warn; console.warn = () => {};
  t.after(() => { global.fetch = fetchOriginal; console.warn = avisoOriginal; });
  const base = fakePoolComFunil({ storeRow: { src: 'fb' }, clickRow: { sck: 'idx_abc', campaign_id: null, user_agent: 'UA', created_at: new Date() } });
  const pool = { calls: base.calls, async query(text, params) {
    if (text.includes('upsell_from = $2') || (text.includes('FROM clicks') && text.includes('campaign_id IS NOT NULL')) || text.includes('SELECT status, capi_sent')) {
      base.calls.push({ text, params });
      throw new Error('banco fora');
    }
    return base.query(text, params);
  } };
  const r = await processarVenda(pool, { txId: 'T38', sck: 'idx_abc', upsellFrom: 'PAI', paid: true, status: 'paid', value: 10, total: 10, origem: 'payt' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(insertSalesArgs(pool.calls)[2], 'idx_abc');
  assert.ok(urls.some(u => u.includes('graph.facebook.com')), 'sem o estado anterior, envia como hoje');
});

// ---- auditoria 2026-10-14, revisao

test('PayT paga com payment_status approved: grava paid e o primeiro Purchase vai', async (t) => {
  const { normalizarPayt } = require('../payt');
  const fetchOriginal = global.fetch; const urls = [];
  global.fetch = async (url) => { urls.push(url); return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  const venda = normalizarPayt({ transaction_id: 'PA1', status: 'paid', transaction: { payment_status: 'approved' },
    link: { query_params: { sck: 'idx_abc' } }, commission: [{ type: 'producer', amount: 1000 }] });
  assert.strictEqual(venda.status, 'paid');
  const pool = fakePoolComFunil({ storeRow: { src: 'fb' } });
  const r = await processarVenda(pool, venda);
  assert.strictEqual(insertSalesArgs(pool.calls)[4], 'paid');
  assert.ok(urls.some(u => u.includes('graph.facebook.com')));
  assert.strictEqual(r.motivo, null);
});

test('upsell com produto nao cadastrado (achou a mae) nao vai para a Meta nem para a TikTok', async (t) => {
  const fetchOriginal = global.fetch; let chamadas = 0;
  global.fetch = async () => { chamadas++; return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  const mae = { sck: 'idx_abc', utm_source: 'FB', utm_campaign: 'Camp', campaign_id: '111111', adset_id: '222222', ad_id: '333333', funnel_id: 1 };
  const comMae = (base) => ({ calls: base.calls, async query(text, params) {
    if (text.includes('upsell_from = $2')) { base.calls.push({ text, params }); return { rows: [mae] }; }
    return base.query(text, params);
  } });
  const pool = comMae(fakePoolComFunil({ storeRow: { src: 'fb' }, tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }] }));
  const r = await processarVenda(pool, { txId: 'UP2', sck: null, upsellFrom: 'PAI2', paid: true, status: 'paid',
    value: 10, total: 10, origem: 'payt', productCode: 'NAOCADASTRADO' });
  assert.strictEqual(chamadas, 0);
  assert.strictEqual(r.motivo, 'produto_nao_envia_meta');
  assert.strictEqual(insertSalesArgs(pool.calls)[14], '111111', 'a atribuicao da mae continua');
  // controle: o mesmo upsell com produto cadastrado (send_to_meta) segue o cadastro
  const cadastrado = comMae(fakePoolComFunil({ storeRow: { src: 'fb' }, produtoRow: { ...produtoTikTok, send_to_tiktok: false } }));
  await processarVenda(cadastrado, { txId: 'UP3', sck: null, upsellFrom: 'PAI2', paid: true, status: 'paid',
    value: 10, total: 10, origem: 'payt', productCode: 'P1' });
  assert.strictEqual(chamadas, 1, 'produto cadastrado com send_to_meta vai');
});

test('as cinco colunas da campanha: venda com campanha A nunca recebe conjunto/anuncio de outra', async () => {
  const pool = fakePool();
  await processarVenda(pool, { txId: 'T40', status: 'pending', paid: false, value: 0 });
  const sql = pool.calls.find(c => c.text.includes('INSERT INTO sales')).text;
  for (const col of ['utm_source', 'utm_campaign', 'campaign_id', 'adset_id', 'ad_id']) {
    const re = new RegExp(`${col} = CASE\\s+WHEN sales\\.campaign_id IS NOT NULL AND sales\\.campaign_id IS DISTINCT FROM EXCLUDED\\.campaign_id THEN sales\\.${col}\\s+`
      + `WHEN sales\\.campaign_id IS NULL AND EXCLUDED\\.campaign_id IS NOT NULL THEN EXCLUDED\\.${col}\\s+`
      + `ELSE COALESCE\\(sales\\.${col}, EXCLUDED\\.${col}\\) END,`);
    assert.ok(re.test(sql), col);
  }
});

test('capi_sent verdadeiro basta para ja_enviada: linha antiga paid -> canceled nao reenvia ao voltar paid', async (t) => {
  const fetchOriginal = global.fetch; let chamadas = 0;
  global.fetch = async () => { chamadas++; return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  const pool = fakePoolComFunil({
    storeRow: { src: 'fb' }, tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }], produtoRow: produtoTikTok,
    antes: { status: 'canceled', capi_sent: true }, retorno: { status: 'paid' },
  });
  const r = await processarVenda(pool, { txId: 'T41', sck: 'idx_abc', paid: true, status: 'paid', value: 10, total: 10, origem: 'payt', productCode: 'P1' });
  assert.strictEqual(chamadas, 0, 'nem Meta nem TikTok');
  assert.strictEqual(r.motivo, 'ja_enviada');
});

test('logs: PAID_STATUS_DIVERGENTE e STATUS_MANTIDO (venda de teste nao loga STATUS_MANTIDO)', async (t) => {
  const fetchOriginal = global.fetch;
  global.fetch = async () => ({ status: 200, json: async () => ({}) });
  const avisoOriginal = console.warn; const avisos = [];
  console.warn = (...a) => avisos.push(a.join(' '));
  t.after(() => { global.fetch = fetchOriginal; console.warn = avisoOriginal; });
  const pool = fakePoolComFunil({ storeRow: { src: 'fb' }, retorno: { status: 'refunded' } });
  await processarVenda(pool, { txId: 'T42', sck: 'idx_abc', paid: true, status: 'approved', statusBruto: 'approved', value: 10, total: 10, origem: 'payt' });
  assert.ok(avisos.some(a => a.startsWith('PAID_STATUS_DIVERGENTE') && a.includes('"status":"approved"') && a.includes('"origem":"payt"')));
  assert.ok(avisos.some(a => a.startsWith('STATUS_MANTIDO') && a.includes('"recebido":"approved"') && a.includes('"ficou":"refunded"')));
  avisos.length = 0;
  await processarVenda(fakePoolComFunil({ storeRow: { src: 'fb' }, retorno: { status: 'paid' } }),
    { txId: 'T43', sck: 'idx_abc', paid: false, teste: true, status: 'test', value: 10, origem: 'payt' });
  assert.ok(!avisos.some(a => a.startsWith('STATUS_MANTIDO') || a.startsWith('PAID_STATUS_DIVERGENTE')));
});

test('clique com campanha limitado a hora da venda: reenvio usa o created_at gravado; venda nova, now()', async () => {
  const clique = { sck: 'idx_abc', campaign_id: null, user_agent: 'UA', created_at: new Date() };
  const criada = new Date('2026-10-10T12:00:00Z');
  const velha = fakePoolComFunil({ storeRow: { src: 'fb' }, clickRow: clique, antes: { status: 'pending', capi_sent: null, created_at: criada } });
  await processarVenda(velha, { txId: 'T44', sck: 'idx_abc', paid: false, status: 'pending', value: 0, origem: 'payt' });
  const q = velha.calls.find(c => c.text.includes('FROM clicks') && c.text.includes('campaign_id IS NOT NULL'));
  assert.ok(/created_at <= COALESCE\(\$2::timestamptz, now\(\)\)/.test(q.text));
  assert.deepStrictEqual(q.params, ['idx_abc', criada]);
  assert.ok(velha.calls.find(c => c.text.includes('SELECT status, capi_sent, created_at FROM sales')));
  const nova = fakePoolComFunil({ storeRow: { src: 'fb' }, clickRow: clique });
  await processarVenda(nova, { txId: 'T45', sck: 'idx_abc', paid: false, status: 'pending', value: 0, origem: 'payt' });
  assert.deepStrictEqual(nova.calls.find(c => c.text.includes('FROM clicks') && c.text.includes('campaign_id IS NOT NULL')).params, ['idx_abc', null]);
});
