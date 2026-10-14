// =====================================================================
//  reatribuir.js — refaz a atribuicao de cliques e vendas dos ultimos N dias
//  com as regras de 2026-10-14 (parametros automaticos do Meta, ::fbclid::
//  colado no id, src da PayT como reserva). So mexe em utm_source, utm_campaign
//  (vendas) e nos tres ids; nunca em status, valor ou CAPI.
//  Uso (de dentro do container, como scripts/q.js):
//    node scripts/reatribuir.js            # simulacao: so mostra o que mudaria
//    node scripts/reatribuir.js --aplicar  # grava, numa transacao
//    node scripts/reatribuir.js --dias 15
// =====================================================================
const { normalizeUtms, semSufixo } = require('../normalize');

const SITES_META = ['fb', 'ig', 'an', 'msg', 'th'];
const NUMERICO = /^\d{6,}$/;

// `src` e o que o header monta juntando, nessa ordem, os utm_* nao vazios:
// source|medium|campaign|content|term — e cada um do modelo da casa e "nome|id".
function parseSrc(src) {
  if (!src || typeof src !== 'string') return null;
  const p = src.split('|').map((s) => s.trim());
  if (p.length === 5 && p[1].toLowerCase() === 'paid') {
    return { utm_source: p[0], utm_medium: p[1], utm_campaign: p[2], utm_content: p[3], utm_term: p[4] };
  }
  if (p.length === 7 || p.length === 8) {
    const r = { utm_source: p[0], utm_medium: `${p[1]}|${p[2]}`, utm_campaign: `${p[3]}|${p[4]}`, utm_content: `${p[5]}|${p[6]}` };
    if (p[7]) r.utm_term = p[7];
    return r;
  }
  return null; // contagem ambigua (nome com "|"?): melhor nao adivinhar
}

function ehAutomaticoSemId(c) {
  return !c.campaign_id && String(c.utm_medium || '').toLowerCase() === 'paid'
    && SITES_META.includes(String(c.utm_source || '').toLowerCase())
    && NUMERICO.test(semSufixo(c.utm_campaign) || '');
}

// Clique gravado antes do fix: devolve as colunas novas, ou null se nada muda.
function cliqueCorrigido(c) {
  if (ehAutomaticoSemId(c)) {
    let u = null;
    try { u = normalizeUtms({ utm_source: c.utm_source, utm_medium: c.utm_medium, utm_campaign: c.utm_campaign, utm_content: c.utm_content, utm_term: c.utm_term }); } catch (e) { return null; }
    if (!u.campaign_id) return null;
    return { utm_source: 'FB', campaign_id: u.campaign_id, adset_id: u.adset_id, ad_id: u.ad_id };
  }
  const limpo = { campaign_id: semSufixo(c.campaign_id), adset_id: semSufixo(c.adset_id), ad_id: semSufixo(c.ad_id) };
  if (limpo.campaign_id === (c.campaign_id ?? null) && limpo.adset_id === (c.adset_id ?? null) && limpo.ad_id === (c.ad_id ?? null)) return null;
  return { utm_source: c.utm_source ?? null, ...limpo };
}

// Venda: `clique` e o clique mais recente do sck (ja corrigido em memoria), ou null.
function vendaCorrigida(v, clique) {
  if (v.campaign_id) {
    const limpo = { campaign_id: semSufixo(v.campaign_id), adset_id: semSufixo(v.adset_id), ad_id: semSufixo(v.ad_id) };
    if (limpo.campaign_id === v.campaign_id && limpo.adset_id === (v.adset_id ?? null) && limpo.ad_id === (v.ad_id ?? null)) return null;
    return { utm_source: v.utm_source ?? null, utm_campaign: v.utm_campaign ?? null, ...limpo };
  }
  if (clique && clique.campaign_id) {
    return { utm_source: clique.utm_source ?? null, utm_campaign: clique.utm_campaign ?? null,
      campaign_id: clique.campaign_id, adset_id: clique.adset_id ?? null, ad_id: clique.ad_id ?? null };
  }
  const raw = parseSrc(v.src);
  if (!raw) return null;
  let u = null;
  try { u = normalizeUtms(raw); } catch (e) { return null; }
  if (!u.campaign_id) return null;
  return { utm_source: u.utm_source, utm_campaign: u.utm_campaign ?? null, campaign_id: u.campaign_id, adset_id: u.adset_id ?? null, ad_id: u.ad_id ?? null };
}

async function reatribuir(pool, { dias = 30, aplicar = false, log = console.log } = {}) {
  const janela = `created_at > now() - ($1::int * interval '1 day')`;
  const { rows: cliques } = await pool.query(
    `SELECT ctid::text AS ctid, sck, funnel_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
            campaign_id, adset_id, ad_id
       FROM clicks
      WHERE ${janela}
        AND ((campaign_id IS NULL AND lower(utm_medium) = 'paid')
             OR campaign_id LIKE '%::%' OR adset_id LIKE '%::%' OR ad_id LIKE '%::%')`, [dias]);
  const { rows: vendas } = await pool.query(
    `SELECT transaction_id, sck, src, funnel_id, value, utm_source, utm_campaign, campaign_id, adset_id, ad_id
       FROM sales
      WHERE ${janela}
        AND (campaign_id IS NULL OR campaign_id LIKE '%::%' OR adset_id LIKE '%::%' OR ad_id LIKE '%::%')`, [dias]);
  const scks = [...new Set(vendas.map((v) => v.sck).filter(Boolean))];
  const { rows: ultimos } = scks.length
    ? await pool.query(
      `SELECT DISTINCT ON (sck) sck, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adset_id, ad_id
         FROM clicks WHERE sck = ANY($1::text[]) ORDER BY sck, created_at DESC`, [scks])
    : { rows: [] };

  // O ultimo clique de cada sck ja com a correcao aplicada em memoria — e o que o webhook usaria hoje.
  // No modelo automatico o utm_campaign gravado e o id cru, nao um nome: a venda herda nome nulo.
  const cliquePorSck = new Map(ultimos.map((c) => {
    const n = cliqueCorrigido(c);
    return [c.sck, n ? { ...c, ...n, ...(ehAutomaticoSemId(c) ? { utm_campaign: null } : {}) } : c];
  }));

  const porFunil = new Map();
  const conta = (f) => { if (!porFunil.has(f)) porFunil.set(f, { cliques: 0, vendasComCampanha: 0, receitaComCampanha: 0, idsLimpos: 0 }); return porFunil.get(f); };

  const mudCliques = [];
  for (const c of cliques) { const n = cliqueCorrigido(c); if (n) { mudCliques.push({ c, n }); conta(c.funnel_id).cliques++; } }
  const mudVendas = [];
  for (const v of vendas) {
    const n = vendaCorrigida(v, v.sck ? cliquePorSck.get(v.sck) || null : null);
    if (!n) continue;
    mudVendas.push({ v, n });
    const f = conta(v.funnel_id);
    if (v.campaign_id) f.idsLimpos++; else { f.vendasComCampanha++; f.receitaComCampanha += Number(v.value) || 0; }
  }

  log(`${mudCliques.length} clique(s) e ${mudVendas.length} venda(s) a corrigir nos ultimos ${dias} dias${aplicar ? '' : ' (simulacao)'}`);
  for (const [f, r] of porFunil) log(`  funil ${f ?? '(sem funil)'}: ${r.cliques} clique(s) · ${r.vendasComCampanha} venda(s) ganham campanha (receita ${r.receitaComCampanha.toFixed(2)}) · ${r.idsLimpos} id(s) limpos`);
  for (const { v, n } of mudVendas.slice(0, 10)) log(`  ex.: venda ${v.transaction_id} -> ${n.utm_source} campanha ${n.campaign_id} conjunto ${n.adset_id} anuncio ${n.ad_id}`);

  if (aplicar && (mudCliques.length || mudVendas.length)) {
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      for (const { c, n } of mudCliques) {
        await cli.query(
          `UPDATE clicks SET utm_source = $1, campaign_id = $2, adset_id = $3, ad_id = $4 WHERE ctid = $5::tid`,
          [n.utm_source, n.campaign_id, n.adset_id, n.ad_id, c.ctid]);
      }
      for (const { v, n } of mudVendas) {
        await cli.query(
          `UPDATE sales SET utm_source = $1, utm_campaign = $2, campaign_id = $3, adset_id = $4, ad_id = $5 WHERE transaction_id = $6`,
          [n.utm_source, n.utm_campaign, n.campaign_id, n.adset_id, n.ad_id, v.transaction_id]);
      }
      await cli.query('COMMIT');
      log('gravado.');
    } catch (e) {
      await cli.query('ROLLBACK');
      throw e;
    } finally {
      cli.release();
    }
  }
  return { cliques: mudCliques.length, vendas: mudVendas.length, porFunil };
}

module.exports = { parseSrc, cliqueCorrigido, vendaCorrigida, reatribuir };

if (require.main === module) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const i = process.argv.indexOf('--dias');
  const dias = i > -1 ? Math.max(1, Math.min(90, Number(process.argv[i + 1]) || 30)) : 30;
  reatribuir(pool, { dias, aplicar: process.argv.includes('--aplicar') })
    .then(() => pool.end())
    .catch((e) => { console.error('ERRO:', e.message); return pool.end().then(() => process.exit(1)); });
}
