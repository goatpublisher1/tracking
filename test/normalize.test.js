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

test('parametros automaticos do Meta (fb|ig, paid, ids crus) viram FB com campanha, conjunto e anuncio', () => {
  const { normalizeUtms } = require('../normalize');
  for (const fonte of ['ig', 'fb', 'IG']) {
    const u = normalizeUtms({
      utm_source: fonte, utm_medium: 'paid',
      utm_campaign: '120257057544780768', utm_term: '120257057544760768',
      utm_content: '120257057578940768::PAZXh0bgNhZW0BMABwZG9m_aem_UIQoyp::',
    });
    assert.strictEqual(u.utm_source, 'FB', fonte);
    assert.strictEqual(u.campaign_id, '120257057544780768');
    assert.strictEqual(u.adset_id, '120257057544760768');
    assert.strictEqual(u.ad_id, '120257057578940768');
    // nesse modelo utm_term e o conjunto, nao o posicionamento
    assert.strictEqual(u.placement, null);
    assert.strictEqual(u.utm_term, null);
  }
});

test('sufixo ::...:: colado no id (fbclid) e descartado; o nome fica', () => {
  const { normalizeUtms } = require('../normalize');
  const u = normalizeUtms({
    utm_source: 'FB', utm_medium: '01 - [HOMEM]|120257032762540768',
    utm_campaign: '[CA-A60] [CAT] [ID-78] [12/10/26] [PURCHASE] [PN] [1-1-5]|120257032762500768',
    utm_content: 'AD148-H1-G10-E0|120257032762520768::PAZXh0bgNhZW0BMABwZG9m::', utm_term: 'Instagram_Reels',
  });
  assert.strictEqual(u.ad_id, '120257032762520768');
  assert.strictEqual(u.utm_content, 'AD148-H1-G10-E0');
  assert.strictEqual(u.campaign_id, '120257032762500768');
  assert.strictEqual(u.adset_id, '120257032762540768');
  assert.strictEqual(u.placement, 'Instagram_Reels');
});

test('modelo nome|id de sempre nao muda; paid de outra plataforma nao vira FB', () => {
  const { normalizeUtms } = require('../normalize');
  const u = normalizeUtms({
    utm_source: 'FB', utm_medium: '01 - [HOMEM]|120250053123410467',
    utm_campaign: '[IDC-CA04] [ID-03]|120250053123370467', utm_content: 'AD297|120250053123400467', utm_term: 'Instagram_Reels',
  });
  assert.deepStrictEqual(
    [u.utm_source, u.campaign_id, u.adset_id, u.ad_id, u.utm_campaign, u.placement],
    ['FB', '120250053123370467', '120250053123410467', '120250053123400467', '[IDC-CA04] [ID-03]', 'Instagram_Reels']);
  const g = normalizeUtms({ utm_source: 'google', utm_medium: 'paid', utm_campaign: '123456789' });
  assert.strictEqual(g.utm_source, 'google');
  assert.strictEqual(g.campaign_id, null);
});
