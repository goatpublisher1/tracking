const { test } = require('node:test');
const assert = require('node:assert');
const { parseSrc, cliqueCorrigido, vendaCorrigida, reatribuir } = require('../scripts/reatribuir');

// ids reais de campanha / conjunto / anuncio
const C = '120257057544780768', S = '120257057544760768', A = '120257057578940768';
const CASA = 'FB|Conj|222222|Camp|111111|Ad|333333';
const cinco = (n) => n && [n.utm_source, n.utm_campaign, n.campaign_id, n.adset_id, n.ad_id];
const t = (h) => new Date(`2026-10-10T${h}:00:00Z`);

test('parseSrc: automatico (5 partes), modelo da casa (8 e 7 partes); outra contagem e null', () => {
  assert.deepStrictEqual(parseSrc('ig|paid|111111|333333::x::|222222'),
    { utm_source: 'ig', utm_medium: 'paid', utm_campaign: '111111', utm_content: '333333::x::', utm_term: '222222' });
  assert.deepStrictEqual(parseSrc('FB|Conj|222222|Camp|111111|Ad|333333|Instagram_Reels'),
    { utm_source: 'FB', utm_medium: 'Conj|222222', utm_campaign: 'Camp|111111', utm_content: 'Ad|333333', utm_term: 'Instagram_Reels' });
  assert.deepStrictEqual(parseSrc(CASA),
    { utm_source: 'FB', utm_medium: 'Conj|222222', utm_campaign: 'Camp|111111', utm_content: 'Ad|333333' });
  for (const v of [null, '', 'fb1', 'a|b|c', 'FB|a|b|c|d|e|f|g|h']) assert.strictEqual(parseSrc(v), null, String(v));
});

test('parseSrc: posicao de id que nao e numero da null (contagem escorregada nao vira id)', () => {
  for (const v of [
    'FB|paid|Camp|111111|Ad|333333|Reels',        // medium sem id: as partes escorregam
    'Conj|222222|Camp|111111|Ad|333333|Reels',    // 7 partes sem fonte
    'FB|Conj|222222|Camp|A|111111|Ad|333333',     // nome com "|"
    'FB|Conj|222222|Camp|{campaignid}|Ad|333333', // macro nao resolvida
    'ig|paid|{campaignid}|333333|222222',
  ]) assert.strictEqual(parseSrc(v), null, v);
  // o ::fbclid:: colado no id nao derruba a leitura (o normalizeUtms corta depois)
  assert.ok(parseSrc(`${CASA}::PAZ::`));
});

test('cliqueCorrigido: automatico gravado antes do fix vira FB com ids; :: e cortado; o resto nao muda', () => {
  assert.deepStrictEqual(
    cliqueCorrigido({ utm_source: 'ig', utm_medium: 'paid', utm_campaign: C, utm_content: `${A}::PAZ::`, utm_term: S, campaign_id: null, adset_id: null, ad_id: null }),
    { utm_source: 'FB', campaign_id: C, adset_id: S, ad_id: A });
  assert.deepStrictEqual(
    cliqueCorrigido({ utm_source: 'FB', utm_medium: 'Conj', campaign_id: '111111', adset_id: '222222', ad_id: '333333::PAZ::' }),
    { utm_source: 'FB', campaign_id: '111111', adset_id: '222222', ad_id: '333333' });
  assert.strictEqual(cliqueCorrigido({ utm_source: 'FB', utm_medium: 'Conj', campaign_id: '111111', adset_id: '222222', ad_id: '333333' }), null);
  assert.strictEqual(cliqueCorrigido({ utm_source: 'google', utm_medium: 'paid', utm_campaign: '123456789', campaign_id: null }), null);
});

test('automatico: id ja gravado nao se apaga quando o utm_* nao traz o dele', () => {
  assert.deepStrictEqual(
    cliqueCorrigido({ utm_source: 'ig', utm_medium: 'paid', utm_campaign: C, utm_content: A, utm_term: '{{adset.id}}', campaign_id: null, adset_id: S, ad_id: null }),
    { utm_source: 'FB', campaign_id: C, adset_id: S, ad_id: A });
});

test('fonte de site do Meta com campanha numerica vira FB mesmo sem outra mudanca; sem campanha fica', () => {
  assert.deepStrictEqual(cliqueCorrigido({ utm_source: 'ig', campaign_id: C, adset_id: S, ad_id: A }),
    { utm_source: 'FB', campaign_id: C, adset_id: S, ad_id: A });
  assert.deepStrictEqual(vendaCorrigida({ utm_source: 'instagram', utm_campaign: 'Camp', campaign_id: C, adset_id: S, ad_id: A }),
    { utm_source: 'FB', utm_campaign: 'Camp', campaign_id: C, adset_id: S, ad_id: A });
  assert.strictEqual(cliqueCorrigido({ utm_source: 'ig', utm_medium: 'social', campaign_id: null }), null);
});

test('campaign_id gravado que nao e numero: o script nao mexe na linha', () => {
  assert.strictEqual(cliqueCorrigido({ utm_source: 'ig', campaign_id: '{campaignid}', ad_id: `${A}::x::` }), null);
  assert.strictEqual(vendaCorrigida({ utm_source: 'ig', campaign_id: 'Teste', ad_id: `${A}::x::`, src: CASA }), null);
});

test('vendaCorrigida: ordem do webhook — URL do checkout com campanha, clique com campanha, venda-mae, nada', () => {
  const clique = { utm_source: 'FB', utm_campaign: 'Clique', campaign_id: '444444', adset_id: '555555', ad_id: '666666' };
  const mae = { utm_source: 'ig', utm_campaign: 'Mae', campaign_id: '777777', adset_id: '888888', ad_id: '999999' };
  assert.deepStrictEqual(cinco(vendaCorrigida({ src: CASA, campaign_id: null }, clique, mae)), ['FB', 'Camp', '111111', '222222', '333333']);
  assert.deepStrictEqual(cinco(vendaCorrigida({ src: 'fb1', campaign_id: null }, clique, mae)), ['FB', 'Clique', '444444', '555555', '666666']);
  // a fonte da mae tambem passa pela regra do Meta
  assert.deepStrictEqual(cinco(vendaCorrigida({ src: null, campaign_id: null }, null, mae)), ['FB', 'Mae', '777777', '888888', '999999']);
  assert.strictEqual(vendaCorrigida({ src: null, campaign_id: null }, { campaign_id: null }, { campaign_id: null }), null);
  // automatico no src: ids crus, nome nulo, :: cortado
  assert.deepStrictEqual(cinco(vendaCorrigida({ src: `ig|paid|${C}|${A}::x::|${S}`, campaign_id: null })), ['FB', null, C, S, A]);
  // ja tem campanha: so limpa; a campanha da venda nunca e trocada
  assert.deepStrictEqual(
    cinco(vendaCorrigida({ src: CASA, utm_source: 'FB', utm_campaign: 'C', campaign_id: '111111', adset_id: '222222', ad_id: '333333::x::' }, clique, mae)),
    ['FB', 'C', '111111', '222222', '333333']);
});

test('utm_url (JSON do checkout) vem antes do src; id do src/utm so numerico (PN | Teste)', () => {
  const utm_url = JSON.stringify({ utm_source: 'ig', utm_campaign: 'U|555555', utm_medium: 'Conj|666666', utm_content: 'PN | Teste' });
  assert.deepStrictEqual(vendaCorrigida({ utm_url, src: CASA, campaign_id: null }),
    { utm_source: 'FB', utm_campaign: 'U', campaign_id: '555555', adset_id: '666666', ad_id: null });
  assert.strictEqual(vendaCorrigida({ src: 'FB|Conj|222222|Camp|111111|PN | Teste', campaign_id: null }), null);
  // JSON cortado (utm_url guarda 2000 caracteres): cai no src
  assert.strictEqual(vendaCorrigida({ utm_url: '{"utm_campa', src: CASA, campaign_id: null }).campaign_id, '111111');
});

// Banco falso: guarda as linhas e responde as consultas do script pelo texto. As leituras de
// selecao devolvem TODAS as linhas (mais do que o WHERE real), entao o JS tem de ignorar o que ja
// esta certo. Os UPDATEs fazem o compare-and-set como o Postgres faria.
function bancoFalso({ cliques = [], vendas = [], utmUrl = true } = {}) {
  const calls = [];
  cliques.forEach((c, i) => { c.ctid = `(0,${i + 1})`; });
  const copia = (rows) => rows.map((r) => ({ ...r }));
  const exec = async (text, params = []) => {
    calls.push({ text, params });
    const q = text.trim();
    if (q.includes('information_schema')) return { rows: utmUrl ? [{ ok: 1 }] : [] };
    if (q.startsWith('UPDATE clicks')) {
      const c = cliques.find((x) => x.ctid === params[4] && (x.sck ?? null) === params[5] && (x.campaign_id ?? null) === params[6]);
      if (c) Object.assign(c, { utm_source: params[0], campaign_id: params[1], adset_id: params[2], ad_id: params[3] });
      return { rows: [], rowCount: c ? 1 : 0 };
    }
    if (q.startsWith('UPDATE sales')) {
      const v = vendas.find((x) => x.transaction_id === params[5] && (x.campaign_id ?? null) === params[6]);
      if (v) Object.assign(v, { utm_source: params[0], utm_campaign: params[1], campaign_id: params[2], adset_id: params[3], ad_id: params[4] });
      return { rows: [], rowCount: v ? 1 : 0 };
    }
    if (q.includes('FROM clicks') && q.includes('sck = ANY')) return { rows: copia(cliques.filter((c) => params[0].includes(c.sck))) };
    if (q.includes('FROM clicks')) return { rows: copia(cliques) };
    if (q.includes('upsell_from = ANY')) return { rows: copia(vendas.filter((v) => params[0].includes(v.transaction_id) || params[0].includes(v.upsell_from))) };
    if (q.includes('FROM sales')) return { rows: copia(vendas) };
    return { rows: [], rowCount: 0 };
  };
  return { calls, cliques, vendas, query: exec, connect: async () => ({ query: exec, release() {} }) };
}
const updates = (calls) => calls.filter((c) => /^\s*UPDATE/.test(c.text));
const venda = (x) => ({ sck: null, src: null, upsell_from: null, funnel_id: 1, value: '10', status: 'paid', created_at: t('12'),
  utm_source: null, utm_campaign: null, campaign_id: null, adset_id: null, ad_id: null, ...x });

test('simulacao nao grava; --aplicar grava cliques e vendas dentro de BEGIN/COMMIT', async () => {
  const dados = () => ({
    cliques: [{ sck: 'idx_1', created_at: t('10'), funnel_id: 1, utm_source: 'ig', utm_medium: 'paid', utm_campaign: C, utm_content: A, utm_term: S, campaign_id: null, adset_id: null, ad_id: null }],
    vendas: [venda({ transaction_id: 'T1', sck: 'idx_1', value: '236.15', utm_source: 'ig' })],
  });
  const sim = bancoFalso(dados());
  const r = await reatribuir(sim, { dias: 30, aplicar: false, log: () => {} });
  assert.strictEqual(r.cliques, 1);
  assert.strictEqual(r.vendas, 1);
  assert.strictEqual(updates(sim.calls).length, 0);

  const ap = bancoFalso(dados());
  await reatribuir(ap, { dias: 30, aplicar: true, log: () => {} });
  const textos = ap.calls.map((c) => c.text.trim().split(/\s+/)[0]);
  assert.strictEqual(textos.filter((x) => x === 'UPDATE').length, 2);
  assert.ok(textos.indexOf('BEGIN') < textos.indexOf('UPDATE') && textos.lastIndexOf('UPDATE') < textos.indexOf('COMMIT'));
  const updVenda = ap.calls.find((c) => c.text.includes('UPDATE sales'));
  assert.deepStrictEqual(updVenda.params, ['FB', null, C, S, A, 'T1', null]);
});

test('clique da venda: o mais recente COM campanha criado ate a venda, ja corrigido em memoria', async () => {
  const db = bancoFalso({
    cliques: [
      // automatico antigo (sem id gravado): so tem campanha depois da correcao em memoria
      { sck: 'idx_1', created_at: t('10'), funnel_id: 1, utm_source: 'ig', utm_medium: 'paid', utm_campaign: C, utm_content: A, utm_term: S, campaign_id: null, adset_id: null, ad_id: null },
      // volta sem anuncio, mais nova
      { sck: 'idx_1', created_at: t('11'), funnel_id: 1, utm_source: 'ig', utm_medium: 'social', campaign_id: null, adset_id: null, ad_id: null },
      // com campanha, mas depois da venda
      { sck: 'idx_1', created_at: t('13'), funnel_id: 1, utm_source: 'FB', utm_campaign: 'Depois', campaign_id: '120000000000009', adset_id: '120000000000008', ad_id: '120000000000007' },
    ],
    vendas: [venda({ transaction_id: 'T1', sck: 'idx_1', utm_source: 'ig' })],
  });
  await reatribuir(db, { aplicar: true, log: () => {} });
  assert.deepStrictEqual(cinco(db.vendas[0]), ['FB', null, C, S, A]);
  const q = db.calls.find((c) => c.text.includes('sck = ANY'));
  assert.match(q.text, /created_at/);
  assert.doesNotMatch(q.text, /DISTINCT ON/);
  assert.deepStrictEqual(q.params, [['idx_1']]);
  assert.match(db.calls.find((c) => /FROM sales\s+WHERE created_at >/.test(c.text)).text, /created_at, upsell_from/);
});

test('venda-mae: upsell sem sck herda a mae corrigida na mesma rodada; rodar de novo nao muda nada', async () => {
  const db = bancoFalso({
    vendas: [
      // o upsell vem primeiro de proposito: a mae so ganha campanha depois dele, na mesma rodada
      venda({ transaction_id: 'U1', upsell_from: 'P1', value: '50' }),
      venda({ transaction_id: 'P1', sck: 'idx_p', src: CASA, value: '100', created_at: t('11') }),
    ],
  });
  await reatribuir(db, { aplicar: true, log: () => {} });
  assert.deepStrictEqual(cinco(db.vendas[0]), ['FB', 'Camp', '111111', '222222', '333333']);
  assert.deepStrictEqual(cinco(db.vendas[1]), ['FB', 'Camp', '111111', '222222', '333333']);
  const q = db.calls.find((c) => c.text.includes('upsell_from = ANY'));
  assert.match(q.text, /transaction_id = ANY/);
  assert.deepStrictEqual(q.params, [['P1']]);
  // o sck da mae entra na busca de cliques (o sck efetivo do upsell, como no webhook)
  assert.deepStrictEqual(db.calls.find((c) => c.text.includes('sck = ANY')).params, [['idx_p']]);

  const n = db.calls.length;
  const r = await reatribuir(db, { aplicar: true, log: () => {} });
  assert.strictEqual(r.vendas + r.cliques, 0);
  assert.strictEqual(updates(db.calls.slice(n)).length, 0);
});

test('rodar de novo nao muda nada, e nenhum UPDATE grava id que nao seja numero', async () => {
  const db = bancoFalso({
    cliques: [
      { sck: 'idx_a', created_at: t('09'), funnel_id: 1, utm_source: 'ig', utm_medium: 'paid', utm_campaign: C, utm_content: `${A}::PAZ::`, utm_term: S, campaign_id: null, adset_id: null, ad_id: null },
      { sck: 'idx_b', created_at: t('09'), funnel_id: 1, utm_source: 'FB', utm_medium: 'Conj', utm_campaign: 'Camp', campaign_id: '111111', adset_id: '222222', ad_id: '333333::x::' },
      { sck: 'idx_c', created_at: t('09'), funnel_id: 2, utm_source: 'instagram', utm_campaign: 'Camp', campaign_id: C, adset_id: S, ad_id: A },
      { sck: 'idx_d', created_at: t('09'), funnel_id: 2, utm_source: 'ig', utm_campaign: 'Camp', campaign_id: C, adset_id: S, ad_id: 'Teste' },
      { sck: 'idx_e', created_at: t('09'), funnel_id: 2, utm_source: 'TT', utm_campaign: 'Camp', campaign_id: '{campaignid}', adset_id: null, ad_id: `${A}::x::` },
    ],
    vendas: [
      venda({ transaction_id: 'V1', src: `${CASA}|Reels` }),
      venda({ transaction_id: 'V2', sck: 'idx_a', utm_source: 'ig' }),
      venda({ transaction_id: 'V3', sck: 'idx_c', utm_source: 'ig', utm_campaign: 'X', campaign_id: C, adset_id: S, ad_id: `${A}::x::` }),
      venda({ transaction_id: 'V4', src: 'FB|paid|Camp|111111|Ad|333333|Reels' }),
      venda({ transaction_id: 'M1', sck: 'idx_b', upsell_from: 'O1', created_at: t('10') }),
      venda({ transaction_id: 'M2', upsell_from: 'O1', created_at: t('11') }),
      venda({ transaction_id: 'V5', utm_url: JSON.stringify({ utm_source: 'fb', utm_campaign: 'U|555555', utm_medium: 'C|{{adset.id}}', utm_content: 'PN | Teste' }) }),
      venda({ transaction_id: 'V6', sck: 'idx_d' }),
    ],
  });
  const r1 = await reatribuir(db, { aplicar: true, log: () => {} });
  assert.strictEqual(r1.ignorados, 0);
  const ups = updates(db.calls);
  const ids = ups.flatMap((c) => (c.text.includes('UPDATE sales') ? c.params.slice(2, 5) : c.params.slice(1, 4)));
  assert.ok(ids.length);
  for (const id of ids) assert.ok(id === null || /^\d{5,}$/.test(id), String(id));
  // V4 (src escorregado) e o clique com campanha {campaignid} ficam como estavam
  assert.ok(!ups.some((c) => c.params.includes('V4') || c.params.includes('idx_e')));
  assert.deepStrictEqual(cinco(db.vendas.find((v) => v.transaction_id === 'M2')), ['FB', 'Camp', '111111', '222222', '333333']);
  assert.deepStrictEqual(cinco(db.vendas.find((v) => v.transaction_id === 'V6')), ['FB', 'Camp', C, S, null]);

  const n = db.calls.length;
  const r2 = await reatribuir(db, { aplicar: true, log: () => {} });
  assert.strictEqual(r2.cliques + r2.vendas, 0);
  assert.strictEqual(updates(db.calls.slice(n)).length, 0);
});

test('UPDATE compare-and-set: linha que mudou depois da leitura fica como esta', async () => {
  const db = bancoFalso({
    cliques: [{ sck: 'idx_9', created_at: t('09'), funnel_id: 1, utm_source: 'ig', campaign_id: C, adset_id: S, ad_id: A }],
    vendas: [venda({ transaction_id: 'T1', src: CASA })],
  });
  const exec = db.query;
  db.connect = async () => ({ release() {}, query: async (text, params) => {
    // o webhook grava a venda e o backfill mexe no clique entre a leitura e o UPDATE
    if (text === 'BEGIN') { db.vendas[0].campaign_id = '999999'; db.cliques[0].campaign_id = '888888'; }
    return exec(text, params);
  } });
  const r = await reatribuir(db, { aplicar: true, log: () => {} });
  assert.strictEqual(r.ignorados, 2);
  assert.strictEqual(db.vendas[0].campaign_id, '999999');
  assert.strictEqual(db.cliques[0].campaign_id, '888888');
  const updV = db.calls.find((c) => c.text.includes('UPDATE sales'));
  assert.match(updV.text, /WHERE transaction_id = \$6 AND campaign_id IS NOT DISTINCT FROM \$7/);
  assert.deepStrictEqual(updV.params.slice(5), ['T1', null]);
  const updC = db.calls.find((c) => c.text.includes('UPDATE clicks'));
  assert.match(updC.text, /WHERE ctid = \$5::tid AND sck IS NOT DISTINCT FROM \$6 AND campaign_id IS NOT DISTINCT FROM \$7/);
  assert.deepStrictEqual(updC.params.slice(4), ['(0,1)', 'idx_9', C]);
});

test('erro no meio do --aplicar: ROLLBACK e o erro sobe', async () => {
  const db = bancoFalso({ vendas: [venda({ transaction_id: 'T1', src: CASA })] });
  const textos = [];
  db.connect = async () => ({ release() {}, query: async (text) => {
    textos.push(text.trim().split(/\s+/)[0]);
    if (/^\s*UPDATE/.test(text)) throw new Error('caiu');
    return { rows: [], rowCount: 0 };
  } });
  await assert.rejects(reatribuir(db, { aplicar: true, log: () => {} }), /caiu/);
  assert.deepStrictEqual(textos, ['BEGIN', 'UPDATE', 'ROLLBACK']);
});

test('selecao inclui fonte de site do Meta com campanha; relatorio: fonte normalizada e receita so da venda paga', async () => {
  const db = bancoFalso({
    vendas: [
      venda({ transaction_id: 'T1', utm_source: 'instagram', utm_campaign: 'Camp', campaign_id: C, adset_id: S, ad_id: A }),
      venda({ transaction_id: 'T2', src: CASA, value: '100', status: 'paid' }),
      venda({ transaction_id: 'T3', src: CASA, value: '50', status: 'pending' }),
    ],
  });
  const linhas = [];
  await reatribuir(db, { log: (l) => linhas.push(l) });
  const fontes = ['fb', 'ig', 'an', 'msg', 'th', 'facebook', 'instagram'];
  for (const tabela of ['sales', 'clicks']) {
    const sel = db.calls.find((c) => new RegExp(`FROM ${tabela}\\s+WHERE created_at >`).test(c.text));
    assert.match(sel.text, /campaign_id IS NOT NULL AND utm_source <> 'FB' AND lower\(utm_source\) = ANY\(\$2::text\[\]\)/);
    assert.deepStrictEqual(sel.params, [30, fontes]);
  }
  const f = linhas.find((l) => l.includes('funil 1'));
  assert.match(f, /2 venda\(s\) ganham campanha \(1 paga\(s\), receita 100\.00\)/);
  assert.match(f, /1 com fonte normalizada/);
});

test('sem a coluna utm_url (ALTER ainda nao rodou): le so o src', async () => {
  const sem = bancoFalso({ utmUrl: false, vendas: [venda({ transaction_id: 'T1', src: CASA })] });
  assert.strictEqual((await reatribuir(sem, { log: () => {} })).vendas, 1);
  assert.match(sem.calls.find((c) => /FROM sales\s+WHERE created_at >/.test(c.text)).text, /NULL AS utm_url/);
  const com = bancoFalso({ vendas: [] });
  await reatribuir(com, { log: () => {} });
  const sel = com.calls.find((c) => /FROM sales\s+WHERE created_at >/.test(c.text)).text;
  assert.match(sel, /\butm_url\b/);
  assert.doesNotMatch(sel, /NULL AS utm_url/);
});
