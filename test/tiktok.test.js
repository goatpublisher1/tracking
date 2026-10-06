const { test } = require('node:test');
const assert = require('node:assert');
const { hash } = require('../capi');
const { buildCompletePaymentEvent, buildInitiateCheckoutEvent, sendTikTokEvent, telefoneE164 } = require('../tiktok');

const pixel = { pixel_code: 'CABC123', access_token: 'tok' };
const click = { sck: 'idx_abc', ttclid: 'E.C.P.x', ttp: 'ttp1', ip: '1.2.3.4', user_agent: 'UA',
  landing_url: 'https://x/vsl', created_at: new Date(1700000000000) };

test('telefone E.164 com +', () => {
  assert.strictEqual(telefoneE164('(11) 99999-8888'), '+5511999998888');
  assert.strictEqual(telefoneE164('+1 415 555 2671'), '+14155552671');
  assert.strictEqual(telefoneE164(''), undefined);
});

test('CompletePayment: user hasheado, ids do clique, properties da venda', () => {
  const ev = buildCompletePaymentEvent({
    pixel,
    sale: { transaction_id: 'T1', value: 97, currency: 'BRL', product_code: 'P1', product_name: 'Prod',
      customer_email: ' A@B.com ', customer_phone: '11999998888', sck: 'idx_abc', event_time: 1700000100 },
    store: { page_location: 'https://x/obrigado', ip_override: '9.9.9.9', user_agent: 'UA2' },
    click,
  });
  assert.strictEqual(ev.event, 'CompletePayment');
  assert.strictEqual(ev.event_id, 'purchase_T1');
  assert.strictEqual(ev.event_time, 1700000100);
  assert.deepStrictEqual(ev.user, {
    email: hash('a@b.com'), phone: hash('+5511999998888'), external_id: hash('idx_abc'),
    ttclid: 'E.C.P.x', ttp: 'ttp1', ip: '9.9.9.9', user_agent: 'UA2',
  });
  assert.deepStrictEqual(ev.properties, {
    value: 97, currency: 'BRL', content_type: 'product', order_id: 'T1',
    contents: [{ content_id: 'P1', content_name: 'Prod', quantity: 1, price: 97 }],
  });
  assert.deepStrictEqual(ev.page, { url: 'https://x/obrigado' });
});

test('CompletePayment: sem e-mail/telefone/ttclid os campos ficam ausentes, nao vazios', () => {
  const ev = buildCompletePaymentEvent({ pixel, sale: { transaction_id: 'T2', value: 10, currency: 'USD', sck: 'idx_abc' }, store: null, click: { ...click, ttclid: null, ttp: null } });
  assert.deepStrictEqual(Object.keys(ev.user).sort(), ['external_id', 'ip', 'user_agent']);
  assert.strictEqual(ev.properties.contents, undefined);
});

test('CompletePayment: IP cai para o da venda so sem store/click; click vence', () => {
  const sale = { transaction_id: 'T3', value: 10, sck: 'idx_abc', ip: '7.7.7.7' };
  assert.strictEqual(buildCompletePaymentEvent({ pixel, sale, store: null, click: null }).user.ip, '7.7.7.7');
  assert.strictEqual(buildCompletePaymentEvent({ pixel, sale, store: null, click }).user.ip, '1.2.3.4');
});

test('IC: event_id = sck, user do clique, sem properties', () => {
  const ev = buildInitiateCheckoutEvent({ pixel, click });
  assert.strictEqual(ev.event, 'InitiateCheckout');
  assert.strictEqual(ev.event_id, 'idx_abc');
  assert.strictEqual(ev.event_time, 1700000000);
  assert.deepStrictEqual(ev.user, { external_id: hash('idx_abc'), ttclid: 'E.C.P.x', ttp: 'ttp1', ip: '1.2.3.4', user_agent: 'UA' });
  assert.strictEqual(ev.properties, undefined);
  assert.deepStrictEqual(ev.page, { url: 'https://x/vsl' });
});

test('IC sem sck ou sem user_agent nao e construido', () => {
  assert.strictEqual(buildInitiateCheckoutEvent({ pixel, click: { ...click, sck: null } }), null);
  assert.strictEqual(buildInitiateCheckoutEvent({ pixel, click: { ...click, user_agent: null } }), null);
});

test('sendTikTokEvent: endpoint, Access-Token, corpo, test_event_code so quando definido', async (t) => {
  const fetchOriginal = global.fetch; const chamadas = [];
  global.fetch = async (url, opts) => { chamadas.push({ url, opts }); return { status: 200, json: async () => ({ code: 0 }) }; };
  const envOriginal = process.env.TIKTOK_TEST_EVENT_CODE;
  t.after(() => { global.fetch = fetchOriginal; if (envOriginal === undefined) delete process.env.TIKTOK_TEST_EVENT_CODE; else process.env.TIKTOK_TEST_EVENT_CODE = envOriginal; });

  delete process.env.TIKTOK_TEST_EVENT_CODE;
  const ev = buildInitiateCheckoutEvent({ pixel, click });
  const r = await sendTikTokEvent({ pixel, event: ev });
  assert.strictEqual(chamadas[0].url, 'https://business-api.tiktok.com/open_api/v1.3/event/track/');
  assert.strictEqual(chamadas[0].opts.headers['Access-Token'], 'tok');
  const corpo = JSON.parse(chamadas[0].opts.body);
  assert.deepStrictEqual(corpo, { event_source: 'web', event_source_id: 'CABC123', data: [ev] });
  assert.deepStrictEqual(r, { httpStatus: 200, response: { code: 0 }, payload: ev });

  process.env.TIKTOK_TEST_EVENT_CODE = ' TEST9 ';
  await sendTikTokEvent({ pixel, event: ev });
  assert.strictEqual(JSON.parse(chamadas[1].opts.body).test_event_code, 'TEST9');
});
