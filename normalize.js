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
    const dec = decodeURIComponent(out.replace(/\+/g, ' '));
    if (dec === out) break;
    out = dec;
  }
  return out.trim();
}

// remove placeholders de macro não resolvidos ({{...}} ou {campaign.id})
function stripPlaceholder(value) {
  if (!value) return null;
  if (/\{\{.*\}\}/.test(value) || /^\{.*\}$/.test(value)) return null;
  return value;
}

// separa "Nome da Campanha|120xxxxx" em { name, id }
function splitNameId(value) {
  if (!value) return { name: null, id: null };
  const idx = value.lastIndexOf('|');
  if (idx === -1) return { name: value, id: null };
  return {
    name: value.slice(0, idx).trim() || null,
    id: value.slice(idx + 1).trim() || null,
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
  const g = (k) => stripPlaceholder(deepDecode(raw[k]));

  const campaign = splitNameId(g('utm_campaign'));
  const content = splitNameId(g('utm_content'));   // costuma trazer ad|id
  const medium = splitNameId(g('utm_medium'));     // costuma trazer adset|id

  return {
    utm_source:   cleanSource(g('utm_source')),
    utm_medium:   medium.name,
    utm_campaign: campaign.name,
    utm_content:  content.name,
    utm_term:     g('utm_term'),        // placement: Facebook_Reels etc
    campaign_id:  campaign.id,
    adset_id:     medium.id,
    ad_id:        content.id,
    placement:    g('utm_term'),
  };
}

module.exports = { normalizeUtms, deepDecode, splitNameId, cleanSource };
