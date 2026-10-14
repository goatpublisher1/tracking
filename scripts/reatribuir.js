// =====================================================================
//  reatribuir.js — refaz a atribuicao de cliques e vendas dos ultimos N dias
//  com as regras de 2026-10-14 (parametros automaticos do Meta, ::fbclid::
//  colado no id, id so numerico, fonte do Meta vira FB) e a ordem do webhook
//  (URL do checkout -> clique com campanha ate a venda -> venda-mae). So mexe
//  em utm_source, utm_campaign (vendas) e nos tres ids; nunca em status, valor
//  ou CAPI. Antes do --aplicar, o backup do HANDOFF.md.
//  Uso (de dentro do container, como scripts/q.js):
//    node scripts/reatribuir.js            # simulacao: so mostra o que mudaria
//    node scripts/reatribuir.js --aplicar  # grava, numa transacao
//    node scripts/reatribuir.js --dias 15
// =====================================================================
const { normalizeUtms, semSufixo, idNumerico, FONTES_SITE_META, metaAutomatico } = require('../normalize');

// `src` e o que o header monta juntando, nessa ordem, os utm_* nao vazios:
// source|medium|campaign|content|term — e cada um do modelo da casa e "nome|id".
function parseSrc(src) {
  if (!src || typeof src !== 'string') return null;
  const p = src.split('|').map((s) => s.trim());
  // Os ids tem posicao fixa: se a posicao nao e numero, a contagem escorregou (medium sem id, nome
  // com "|", fonte faltando, macro nao resolvida) e o resto sairia trocado. Melhor nao adivinhar.
  if (p.length === 5 && p[1].toLowerCase() === 'paid') {
    if (!idNumerico(p[2])) return null;
    return { utm_source: p[0], utm_medium: p[1], utm_campaign: p[2], utm_content: p[3], utm_term: p[4] };
  }
  if (p.length === 7 || p.length === 8) {
    if (![p[2], p[4], p[6]].every(idNumerico)) return null;
    const r = { utm_source: p[0], utm_medium: `${p[1]}|${p[2]}`, utm_campaign: `${p[3]}|${p[4]}`, utm_content: `${p[5]}|${p[6]}` };
    if (p[7]) r.utm_term = p[7];
    return r;
  }
  return null; // contagem ambigua (nome com "|"?): melhor nao adivinhar
}

// Mesma regra do /collect (metaAutomatico): fb/ig/an/msg/th, medium paid, campanha crua de 6+ digitos.
function ehAutomaticoSemId(c) {
  return !c.campaign_id && !!metaAutomatico((k) => c[k]);
}

const COLUNAS = ['utm_source', 'utm_campaign', 'campaign_id', 'adset_id', 'ad_id'];
const temCampanha = (x) => !!(x && idNumerico(x.campaign_id));
const iguais = (a, b, ks) => ks.every((k) => (a[k] ?? null) === (b[k] ?? null));

// As colunas no formato de hoje: ids so numericos (sem ::fbclid::) e fonte de site do Meta com
// campanha virando FB, como o normalizeUtms faz no /collect. Sem campanha (organico) a fonte fica.
function colunas(x) {
  const campaign_id = idNumerico(x.campaign_id);
  const meta = campaign_id && FONTES_SITE_META.has(String(x.utm_source || '').toLowerCase());
  return { utm_source: meta ? 'FB' : (x.utm_source ?? null), utm_campaign: x.utm_campaign ?? null,
    campaign_id, adset_id: idNumerico(x.adset_id), ad_id: idNumerico(x.ad_id) };
}

// Clique gravado antes do fix: devolve as colunas novas, ou null se nada muda.
function cliqueCorrigido(c) {
  // campaign_id gravado que nao e numero ({campaignid} de macro): o script nao adivinha, nao mexe
  if (c.campaign_id && !idNumerico(c.campaign_id)) return null;
  let n;
  if (ehAutomaticoSemId(c)) {
    let u = null;
    try { u = normalizeUtms({ utm_source: c.utm_source, utm_medium: c.utm_medium, utm_campaign: c.utm_campaign, utm_content: c.utm_content, utm_term: c.utm_term }); } catch (e) { return null; }
    if (!u.campaign_id) return null;
    // id ja gravado nao se apaga quando o utm_* nao traz o dele
    n = { utm_source: 'FB', campaign_id: u.campaign_id, adset_id: u.adset_id ?? idNumerico(c.adset_id), ad_id: u.ad_id ?? idNumerico(c.ad_id) };
  } else {
    const { utm_campaign, ...resto } = colunas(c); // utm_campaign do clique nao e gravado
    n = resto;
  }
  return iguais(n, c, ['utm_source', 'campaign_id', 'adset_id', 'ad_id']) ? null : n;
}

// utm_* da URL do checkout: o JSON cru (utm_url, venda gravada depois de 2026-10-14) ou o src que o
// header montou. JSON cortado (utm_url guarda 2000 caracteres) cai no src.
function daUrl(v) {
  let json = null;
  try { json = v.utm_url ? JSON.parse(v.utm_url) : null; } catch (e) { /* cortado: fica o src */ }
  for (const raw of [json, parseSrc(v.src)]) {
    if (!raw || typeof raw !== 'object') continue;
    let u = null;
    try { u = normalizeUtms(raw); } catch (e) { /* nao lanca desde 2026-10-14; cinto */ }
    if (temCampanha(u)) return u;
  }
  return null;
}

// Venda: devolve as cinco colunas novas, ou null se nada muda. `clique` e o clique mais recente do
// sck com campanha ate a hora da venda (ja corrigido em memoria); `mae` e a venda-mae (upsell).
function vendaCorrigida(v, clique = null, mae = null) {
  // campaign_id gravado que nao e numero: o script nao adivinha, nao mexe
  if (v.campaign_id && !idNumerico(v.campaign_id)) return null;
  // Ja tem campanha: so limpa ids e fonte (o webhook tambem nunca troca a campanha de uma venda).
  // Sem campanha, a ordem do webhook: URL do checkout -> clique -> venda-mae, cada um com campanha.
  const alvo = v.campaign_id ? v : [daUrl(v), clique, mae].find(temCampanha);
  if (!alvo) return null;
  const n = colunas(alvo);
  return iguais(n, v, COLUNAS) ? null : n;
}

async function reatribuir(pool, { dias = 30, aplicar = false, log = console.log } = {}) {
  // --aplicar so com o backup do HANDOFF.md feito: sem ele nao ha como desfazer. Antes de qualquer
  // leitura, para nao gravar nada. A simulacao nao precisa dele.
  if (aplicar) {
    const { rows: [b] } = await pool.query(
      `SELECT to_regclass('sales_reatrib_bkp') AS vendas, to_regclass('clicks_reatrib_bkp') AS cliques`);
    const faltam = [!b?.vendas && 'sales_reatrib_bkp', !b?.cliques && 'clicks_reatrib_bkp'].filter(Boolean);
    if (faltam.length) {
      throw new Error(`--aplicar recusado, nada foi gravado: falta o backup (${faltam.join(', ')}). `
        + 'Rode os CREATE TABLE da secao "Reatribuir o historico" do HANDOFF.md e tente de novo.');
    }
  }
  const fontes = [...FONTES_SITE_META];
  // utm_url e coluna de 2026-10-14: o script pode rodar antes do ALTER. Sem ela, so o src.
  const { rows: temUtmUrl } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'sales' AND column_name = 'utm_url'`);
  const janela = `created_at > now() - ($1::int * interval '1 day')`;
  // Fonte de site do Meta com campanha: so a que ainda nao e 'FB' (senao entraria todo clique pago).
  const fonteMeta = `(campaign_id IS NOT NULL AND utm_source <> 'FB' AND lower(utm_source) = ANY($2::text[]))`;
  // sck IS NOT NULL: o backup do HANDOFF desfaz clique por (sck, created_at); sem sck nao teria volta.
  // created_at como texto: o Date do JS guarda milissegundos e o Postgres microssegundos; o UPDATE
  // compara com o valor exato lido.
  const { rows: cliques } = await pool.query(
    `SELECT ctid::text AS ctid, sck, created_at::text AS created_at_lido, funnel_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
            campaign_id, adset_id, ad_id
       FROM clicks
      WHERE ${janela} AND sck IS NOT NULL
        AND ((campaign_id IS NULL AND lower(utm_medium) = 'paid')
             OR campaign_id LIKE '%::%' OR adset_id LIKE '%::%' OR ad_id LIKE '%::%' OR ${fonteMeta})`, [dias, fontes]);
  // ORDER BY created_at: a mae (mais antiga) e resolvida antes do upsell, como o webhook as viu
  const { rows: vendas } = await pool.query(
    `SELECT transaction_id, sck, src, ${temUtmUrl.length ? 'utm_url' : 'NULL AS utm_url'}, funnel_id, value, status, created_at, upsell_from,
            utm_source, utm_campaign, campaign_id, adset_id, ad_id
       FROM sales
      WHERE ${janela}
        AND (campaign_id IS NULL OR campaign_id LIKE '%::%' OR adset_id LIKE '%::%' OR ad_id LIKE '%::%' OR ${fonteMeta})
      ORDER BY created_at`, [dias, fontes]);

  // Venda-mae, a mesma consulta do webhook: na PayT a mae e transaction_id = upsell_from; na
  // Digistore24, as vendas com a mesma order_id em upsell_from.
  const pedidos = [...new Set(vendas.map((v) => v.upsell_from).filter(Boolean))];
  const { rows: maes } = pedidos.length
    ? await pool.query(
      `SELECT transaction_id, upsell_from, sck, created_at, utm_source, utm_campaign, campaign_id, adset_id, ad_id
         FROM sales WHERE transaction_id = ANY($1::text[]) OR upsell_from = ANY($1::text[])`, [pedidos])
    : { rows: [] };

  // Todos os cliques dos sck (o da venda e o da mae, que e o sck efetivo do upsell no webhook),
  // cada um corrigido em memoria: e o que o webhook usaria hoje. No modelo automatico o utm_campaign
  // gravado e o proprio id cru, nao um nome: a venda herda nome nulo (como no /collect novo).
  const scks = [...new Set([...vendas, ...maes].map((x) => x.sck).filter(Boolean))];
  const { rows: todos } = scks.length
    ? await pool.query(
      `SELECT sck, created_at, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adset_id, ad_id
         FROM clicks WHERE sck = ANY($1::text[])`, [scks])
    : { rows: [] };
  const cliquesDoSck = new Map();
  for (const c of todos) {
    const x = { ...c, ...cliqueCorrigido(c) };
    if (x.campaign_id && semSufixo(x.utm_campaign) === x.campaign_id) x.utm_campaign = null;
    if (!cliquesDoSck.has(c.sck)) cliquesDoSck.set(c.sck, []);
    cliquesDoSck.get(c.sck).push(x);
  }
  const ms = (d) => new Date(d).getTime();
  // o mais recente com campanha criado ate a venda (o webhook limita pela hora gravada da venda)
  const cliqueDe = (sck, ate) => (cliquesDoSck.get(sck) || [])
    .filter((c) => temCampanha(c) && ms(c.created_at) <= ms(ate))
    .reduce((a, c) => (!a || ms(c.created_at) > ms(a.created_at) ? c : a), null);

  const resolvidas = new Map(); // transaction_id -> colunas novas
  // A mae como o webhook a escolhe (com campanha primeiro, depois a mais antiga), ja com a correcao
  // desta rodada: sem isso o upsell so herdaria a campanha da mae numa segunda rodada.
  // ponytail: busca linear em `maes` por venda; indexar por pedido se passar de milhares de upsells
  const maeDe = (v) => (v.upsell_from ? maes
    .filter((m) => m.transaction_id !== v.transaction_id && (m.transaction_id === v.upsell_from || m.upsell_from === v.upsell_from))
    .map((m) => ({ ...m, ...resolvidas.get(m.transaction_id) }))
    .sort((a, b) => (temCampanha(b) - temCampanha(a)) || (ms(a.created_at) - ms(b.created_at)))[0] || null : null);
  // Ate estabilizar: a correcao de uma venda pode dar campanha a mae de outra. Venda que achou a sua
  // fica com ela (no banco tambem: venda com campanha nao volta para a cadeia), entao termina; e o
  // estado final e o que uma segunda rodada leria, por isso ela nao muda nada.
  for (let novas = true; novas;) {
    novas = false;
    for (const v of vendas) {
      if (resolvidas.has(v.transaction_id)) continue;
      const mae = maeDe(v);
      const n = vendaCorrigida(v, cliqueDe(v.sck || mae?.sck, v.created_at), mae);
      if (n) { resolvidas.set(v.transaction_id, n); novas = true; }
    }
  }

  const porFunil = new Map();
  const conta = (f) => {
    if (!porFunil.has(f)) porFunil.set(f, { cliques: 0, vendasComCampanha: 0, pagas: 0, receitaComCampanha: 0, idsLimpos: 0, fonteNormalizada: 0 });
    return porFunil.get(f);
  };

  const mudCliques = [];
  for (const c of cliques) { const n = cliqueCorrigido(c); if (n) { mudCliques.push({ c, n }); conta(c.funnel_id).cliques++; } }
  const mudVendas = [];
  for (const v of vendas) {
    const n = resolvidas.get(v.transaction_id);
    if (!n) continue;
    mudVendas.push({ v, n });
    const f = conta(v.funnel_id);
    if (v.campaign_id) {
      if (n.utm_source !== (v.utm_source ?? null)) f.fonteNormalizada++;
      if (!iguais(n, v, ['campaign_id', 'adset_id', 'ad_id'])) f.idsLimpos++;
    } else {
      f.vendasComCampanha++;
      // receita so da venda paga: pendente/cancelada nao e dinheiro que a campanha trouxe
      if (v.status === 'paid') { f.pagas++; f.receitaComCampanha += Number(v.value) || 0; }
    }
  }

  // selecionadas, mas com campaign_id gravado que nao e numero: o script nao mexe (ver vendaCorrigida)
  const naoNumerica = (x) => !!x.campaign_id && !idNumerico(x.campaign_id);
  const naoNumericas = { vendas: vendas.filter(naoNumerica).length, cliques: cliques.filter(naoNumerica).length };

  log(`${mudCliques.length} clique(s) e ${mudVendas.length} venda(s) a corrigir nos ultimos ${dias} dias${aplicar ? '' : ' (simulacao)'}`);
  log(`${naoNumericas.vendas} venda(s) e ${naoNumericas.cliques} clique(s) com campanha gravada nao numerica — nao mexidas`);
  for (const [f, r] of porFunil) {
    log(`  funil ${f ?? '(sem funil)'}: ${r.cliques} clique(s) · ${r.vendasComCampanha} venda(s) ganham campanha (${r.pagas} paga(s), receita ${r.receitaComCampanha.toFixed(2)}) · ${r.idsLimpos} com ids limpos · ${r.fonteNormalizada} com fonte normalizada`);
  }
  for (const { v, n } of mudVendas.slice(0, 10)) log(`  ex.: venda ${v.transaction_id} -> ${n.utm_source} campanha ${n.campaign_id} conjunto ${n.adset_id} anuncio ${n.ad_id}`);

  let ignorados = 0;
  if (aplicar && (mudCliques.length || mudVendas.length)) {
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      // Compare-and-set: so grava se a linha ainda tem o que foi lido (venda: as cinco colunas; clique:
      // ctid, sck, created_at e campaign_id). O webhook (ou o backfill horario, que muda o ctid do
      // clique) pode ter mexido nela no meio: ai ela fica como esta.
      for (const { c, n } of mudCliques) {
        const r = await cli.query(
          `UPDATE clicks SET utm_source = $1, campaign_id = $2, adset_id = $3, ad_id = $4
            WHERE ctid = $5::tid AND sck IS NOT DISTINCT FROM $6 AND created_at = $7::timestamptz AND campaign_id IS NOT DISTINCT FROM $8`,
          [n.utm_source, n.campaign_id, n.adset_id, n.ad_id, c.ctid, c.sck ?? null, c.created_at_lido, c.campaign_id ?? null]);
        if (!r.rowCount) ignorados++;
      }
      for (const { v, n } of mudVendas) {
        const r = await cli.query(
          `UPDATE sales SET utm_source = $1, utm_campaign = $2, campaign_id = $3, adset_id = $4, ad_id = $5
            WHERE transaction_id = $6
              AND (utm_source, utm_campaign, campaign_id, adset_id, ad_id) IS NOT DISTINCT FROM ($7, $8, $9, $10, $11)`,
          [n.utm_source, n.utm_campaign, n.campaign_id, n.adset_id, n.ad_id, v.transaction_id, ...COLUNAS.map((k) => v[k] ?? null)]);
        if (!r.rowCount) ignorados++;
      }
      await cli.query('COMMIT');
      log(`gravado.${ignorados ? ` ${ignorados} linha(s) mudaram depois da leitura e ficaram como estavam (rode de novo).` : ''}`);
    } catch (e) {
      await cli.query('ROLLBACK').catch(() => {}); // o erro que importa e o original
      throw e;
    } finally {
      cli.release();
    }
  }
  return { cliques: mudCliques.length, vendas: mudVendas.length, porFunil, ignorados, naoNumericas };
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
