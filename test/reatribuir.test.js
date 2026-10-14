const { test } = require('node:test');
const assert = require('node:assert');
const { parseSrc, cliqueCorrigido, vendaCorrigida, reatribuir } = require('../scripts/reatribuir');

test('parseSrc: automatico (5 partes), modelo da casa (8 e 7 partes); outra contagem e null', () => {
  assert.deepStrictEqual(parseSrc('ig|paid|111111|333333::x::|222222'),
    { utm_source: 'ig', utm_medium: 'paid', utm_campaign: '111111', utm_content: '333333::x::', utm_term: '222222' });
  assert.deepStrictEqual(parseSrc('FB|Conj|222|Camp|111|Ad|333|Instagram_Reels'),
    { utm_source: 'FB', utm_medium: 'Conj|222', utm_campaign: 'Camp|111', utm_content: 'Ad|333', utm_term: 'Instagram_Reels' });
  assert.deepStrictEqual(parseSrc('FB|Conj|222|Camp|111|Ad|333'),
    { utm_source: 'FB', utm_medium: 'Conj|222', utm_campaign: 'Camp|111', utm_content: 'Ad|333' });
  for (const v of [null, '', 'fb1', 'a|b|c', 'FB|a|b|c|d|e|f|g|h']) assert.strictEqual(parseSrc(v), null, String(v));
});

test('cliqueCorrigido: automatico gravado antes do fix vira FB com ids; :: e cortado; o resto nao muda', () => {
  assert.deepStrictEqual(
    cliqueCorrigido({ utm_source: 'ig', utm_medium: 'paid', utm_campaign: '120257057544780768', utm_content: '120257057578940768::PAZ::', utm_term: '120257057544760768', campaign_id: null, adset_id: null, ad_id: null }),
    { utm_source: 'FB', campaign_id: '120257057544780768', adset_id: '120257057544760768', ad_id: '120257057578940768' });
  assert.deepStrictEqual(
    cliqueCorrigido({ utm_source: 'FB', utm_medium: 'Conj', campaign_id: '111', adset_id: '222', ad_id: '333::PAZ::' }),
    { utm_source: 'FB', campaign_id: '111', adset_id: '222', ad_id: '333' });
  assert.strictEqual(cliqueCorrigido({ utm_source: 'FB', utm_medium: 'Conj', campaign_id: '111', adset_id: '222', ad_id: '333' }), null);
  assert.strictEqual(cliqueCorrigido({ utm_source: 'google', utm_medium: 'paid', utm_campaign: '123456789', campaign_id: null }), null);
});

test('vendaCorrigida: clique do sck com campanha vence; sem ele, o src; sem nada, null', () => {
  const clique = { utm_source: 'FB', utm_campaign: 'Camp', campaign_id: '111', adset_id: '222', ad_id: '333' };
  assert.deepStrictEqual(vendaCorrigida({ sck: 'idx_1', src: 'ig|paid|9|8|7', campaign_id: null }, clique),
    { utm_source: 'FB', utm_campaign: 'Camp', campaign_id: '111', adset_id: '222', ad_id: '333' });
  assert.deepStrictEqual(vendaCorrigida({ sck: null, src: 'ig|paid|120257057544780768|120257057578940768::x::|120257057544760768', campaign_id: null }, null),
    { utm_source: 'FB', utm_campaign: null, campaign_id: '120257057544780768', adset_id: '120257057544760768', ad_id: '120257057578940768' });
  assert.deepStrictEqual(vendaCorrigida({ sck: null, src: null, utm_source: 'FB', utm_campaign: 'C', campaign_id: '111', adset_id: '222', ad_id: '333::x::' }, null),
    { utm_source: 'FB', utm_campaign: 'C', campaign_id: '111', adset_id: '222', ad_id: '333' });
  assert.strictEqual(vendaCorrigida({ sck: null, src: 'fb1', campaign_id: null }, null), null);
});

function poolFalso({ cliques = [], vendas = [], ultimos = [] }) {
  const calls = [];
  const exec = async (text, params) => {
    calls.push({ text, params });
    if (text.includes('FROM clicks') && text.includes('ctid')) return { rows: cliques };
    if (text.includes('FROM sales')) return { rows: vendas };
    if (text.includes('DISTINCT ON (sck)')) return { rows: ultimos };
    return { rows: [], rowCount: 1 };
  };
  return { calls, query: exec, connect: async () => ({ query: exec, release() {} }) };
}

test('simulacao nao grava; --aplicar grava cliques e vendas dentro de BEGIN/COMMIT', async () => {
  const dados = {
    cliques: [{ ctid: '(0,1)', sck: 'idx_1', funnel_id: 1, utm_source: 'ig', utm_medium: 'paid', utm_campaign: '120257057544780768', utm_content: '120257057578940768', utm_term: '120257057544760768', campaign_id: null, adset_id: null, ad_id: null }],
    vendas: [{ transaction_id: 'T1', sck: 'idx_1', src: null, funnel_id: 1, value: '236.15', utm_source: 'ig', utm_campaign: null, campaign_id: null, adset_id: null, ad_id: null }],
    ultimos: [{ sck: 'idx_1', utm_source: 'ig', utm_medium: 'paid', utm_campaign: '120257057544780768', utm_content: '120257057578940768', utm_term: '120257057544760768', campaign_id: null, adset_id: null, ad_id: null }],
  };
  const sim = poolFalso(dados);
  const r = await reatribuir(sim, { dias: 30, aplicar: false, log: () => {} });
  assert.strictEqual(r.cliques, 1);
  assert.strictEqual(r.vendas, 1);
  assert.strictEqual(sim.calls.filter((c) => /^\s*UPDATE/.test(c.text)).length, 0);

  const ap = poolFalso(dados);
  await reatribuir(ap, { dias: 30, aplicar: true, log: () => {} });
  const textos = ap.calls.map((c) => c.text.trim().split(/\s+/)[0]);
  assert.strictEqual(textos.filter((t) => t === 'UPDATE').length, 2);
  assert.ok(textos.indexOf('BEGIN') < textos.indexOf('UPDATE') && textos.lastIndexOf('UPDATE') < textos.indexOf('COMMIT'));
  const updVenda = ap.calls.find((c) => c.text.includes('UPDATE sales'));
  assert.deepStrictEqual(updVenda.params, ['FB', null, '120257057544780768', '120257057544760768', '120257057578940768', 'T1']);
});
