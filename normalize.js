// =====================================================================
//  normalize.js — Limpeza e normalização de UTMs
//  Resolve os problemas reais vistos nos dados do Atomicat:
//   - encoding duplicado: "01+-+%5BHOMEM%5D" vs "01 - [HOMEM]"
//   - pixel grudado no source: "FBjLj6a32fca149..." -> "FB"
//   - placeholders não resolvidos: "{{campaign.name}}"
//   - formato "nome|id" nos campos de campanha/adset/ad
// =====================================================================

// decodifica repetidamente até estabilizar (trata %5B%5D e + como espaço)
function deepDecode(value) {
  if (!value) return value;
  let out = String(value);
  for (let i = 0; i < 3; i++) {
    // "%" solto em nome de anuncio ("Oferta 50% OFF") fazia decodeURIComponent lancar: o /collect
    // devolvia 500 e as UTMs da venda se perdiam. Nunca lanca: no erro, fica o ultimo valor bom.
    let dec;
    try { dec = decodeURIComponent(out.replace(/\+/g, ' ')); } catch (e) { break; }
    if (dec === out) break;
    out = dec;
  }
  return out.trim();
}

// remove placeholders de macro não resolvidos ({{...}}, {campaign.id} ou __CAMPAIGN_ID__ do TikTok)
function stripPlaceholder(value) {
  if (!value) return null;
  if (/\{\{.*\}\}/.test(value) || /^\{.*\}$/.test(value) || /^__[A-Z0-9_]+__$/.test(value)) return null;
  return value;
}

// Algumas contas mandam o fbclid colado no fim do id ("120xxx::PAZ...::"). Sem cortar,
// o ad_id gravado nunca casa com o id do gerenciador e a venda some da linha do anuncio.
function semSufixo(id) {
  return id ? (id.replace(/::.*$/, '').trim() || null) : null;
}

// Id de campanha/conjunto/anuncio so vale se for numerico (5+ digitos). Qualquer outra coisa depois
// do "|" ("Teste", "{adgroupid}", "C9") e lixo de macro e nao pode virar id gravado.
function idNumerico(v) {
  const x = stripPlaceholder(semSufixo(v));
  return /^\d{5,}$/.test(x || '') ? x : null;
}

// separa "Nome da Campanha|120xxxxx" em { name, id }. O placeholder sai por parte: com
// "{{campaign.name}}|120xxx" o nome some mas o id, que e valido, fica.
function splitNameId(value) {
  if (!value) return { name: null, id: null };
  const idx = value.lastIndexOf('|');
  if (idx === -1) return { name: stripPlaceholder(value), id: null };
  return {
    name: stripPlaceholder(value.slice(0, idx).trim() || null),
    id: idNumerico(value.slice(idx + 1)),
  };
}

// Parametros automaticos do Meta: utm_source={{site_source_name}} (fb, ig, an, msg, th),
// utm_medium=paid e os ids crus (campanha em utm_campaign, conjunto em utm_term, anuncio em
// utm_content). Campanha criada sem o nosso modelo "nome|id" chega assim; antes o clique
// ficava sem id nenhum e com utm_source "ig"/"fb", que nenhuma fonte reconhece.
const SITES_META = new Set(['fb', 'ig', 'an', 'msg', 'th']);
// Fontes que o Meta/usuario escreve no utm_source do modelo "nome|id" (inclui os nomes por extenso).
// Separado de SITES_META de proposito: o caminho automatico acima nao muda.
const FONTES_SITE_META = new Set([...SITES_META, 'facebook', 'instagram']);
function metaAutomatico(g) {
  const fonte = (g('utm_source') || '').toLowerCase();
  const meio = (g('utm_medium') || '').toLowerCase();
  const campanha = semSufixo(g('utm_campaign'));
  if (meio !== 'paid' || !SITES_META.has(fonte) || !/^\d{6,}$/.test(campanha || '')) return null;
  const digitos = (v) => { const x = semSufixo(v); return /^\d{6,}$/.test(x || '') ? x : null; };
  return {
    utm_source: 'FB', utm_medium: 'paid', utm_campaign: null, utm_content: null, utm_term: null,
    campaign_id: campanha, adset_id: digitos(g('utm_term')), ad_id: digitos(g('utm_content')), placement: null,
  };
}

// limpa o utm_source: se vier o pixel colado (FBjLj6...), reduz a "FB"
function cleanSource(value) {
  if (!value) return null;
  const v = value.trim();
  // padrão observado: "FB" seguido de hash de pixel
  const m = v.match(/^(FB|fb|organic|google|direto|direct)/i);
  if (m && v.length > m[1].length + 6) return m[1].toUpperCase() === 'FB' ? 'FB' : m[1];
  return v;
}

// entrada: objeto de query params cru; saída: campos normalizados
function normalizeUtms(raw = {}) {
  // sem stripPlaceholder aqui: o placeholder sai por parte (nome e id) em splitNameId
  const g = (k) => deepDecode(raw[k]);

  const auto = metaAutomatico(g);
  if (auto) return auto;

  const campaign = splitNameId(g('utm_campaign'));
  const content = splitNameId(g('utm_content'));   // costuma trazer ad|id
  const medium = splitNameId(g('utm_medium'));     // costuma trazer adset|id

  const term = stripPlaceholder(g('utm_term'));   // placement: Facebook_Reels etc
  const out = {
    utm_source:   cleanSource(stripPlaceholder(g('utm_source'))),
    utm_medium:   medium.name,
    utm_campaign: campaign.name,
    utm_content:  content.name,
    utm_term:     term,
    campaign_id:  campaign.id,
    adset_id:     medium.id,
    ad_id:        content.id,
    placement:    term,
  };
  // Clique de anuncio do Meta que veio com "ig"/"facebook" no utm_source nao casa com nenhuma fonte
  // do dashboard. Com campanha numerica e anuncio pago: vira FB. Sem campanha (organico) fica como veio.
  if (out.campaign_id && FONTES_SITE_META.has((out.utm_source || '').toLowerCase())) out.utm_source = 'FB';
  return out;
}

// Identificadores de clique do Google Ads. gclid vem no desktop/Android; gbraid e
// wbraid no iOS (App Tracking Transparency). ttclid e o id de clique do TikTok Ads,
// na URL de entrada. Todos sao gravados em clicks; gclid/gbraid/wbraid so servem ao
// upload de conversoes do dashboard, e o ttclid tambem vai ao TikTok (tiktok.js).
const CLICK_KEYS = ['gclid', 'gbraid', 'wbraid', 'ttclid'];
function clickIds(b) {
  const out = {};
  for (const k of CLICK_KEYS) {
    const v = b && typeof b[k] === 'string' ? b[k].trim() : '';
    out[k] = v ? v.slice(0, 200) : null;
  }
  return out;
}

// Cookie _ttp do pixel do TikTok, lido pelo header e mandado no /collect.
// Nao e id de clique (nao vem na URL): e o id do navegador, como o _fbp.
function ttpDe(b) {
  const v = b && typeof b.ttp === 'string' ? b.ttp.trim() : '';
  return v ? v.slice(0, 200) : null;
}

module.exports = { normalizeUtms, deepDecode, splitNameId, cleanSource, clickIds, ttpDe, semSufixo };
