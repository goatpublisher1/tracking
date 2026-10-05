// =====================================================================
//  ic.js — InitiateCheckout pela CAPI, disparado do /collect.
//
//  Setup redundante que a Meta recomenda: o header ja manda o IC pelo pixel
//  com eventID = sck; aqui vai o mesmo evento pelo servidor, com o mesmo
//  event_id, e a Meta deduplica (48h). O ganho e o user_data que o pixel
//  sozinho nao tem garantido (ip, user agent, fbc montado do fbclid,
//  external_id) e o evento chegar mesmo com bloqueador no navegador.
//
//  Nunca lanca e nunca roda antes da resposta do /collect: quem chama faz
//  setImmediate(() => enviarIC(...)). Falha da Meta vira log CAPI_IC_FALHOU.
//  Kill switch: CAPI_IC_DESLIGADO=1.
// =====================================================================
const { sendInitiateCheckout } = require('./capi');
const tiktok = require('./tiktok');

async function enviarIC(pool, { dominio, click }) {
  if (process.env.CAPI_IC_DESLIGADO === '1') return { enviados: 0, aceitos: 0, desligado: true };
  if (!click || !click.sck || !dominio) return { enviados: 0, aceitos: 0 };

  let funnels = [];
  try {
    const r = await pool.query('SELECT * FROM funnels WHERE active AND domain = $1', [dominio]);
    funnels = r.rows || [];
  } catch (e) {
    console.error('CAPI_IC_FALHOU', JSON.stringify({ etapa: 'funis', dominio, erro: String(e).slice(0, 200) }));
    return { enviados: 0, aceitos: 0 };
  }
  if (!funnels.length) return { enviados: 0, aceitos: 0 };

  let aceitos = 0;
  for (const f of funnels) {
    let status = 0; let resp = null; let payload = null;
    try {
      const r = await sendInitiateCheckout({ funnel: f, click });
      status = r.httpStatus; resp = r.response; payload = r.payload;
      if (status === 200) aceitos++;
      else console.error('CAPI_IC_FALHOU', JSON.stringify({ pixel: f.pixel_id, sck: click.sck, status, resp }));
    } catch (e) {
      console.error('CAPI_IC_FALHOU', JSON.stringify({ pixel: f.pixel_id, sck: click.sck, erro: String(e).slice(0, 200) }));
    }
    try {
      await pool.query(
        `INSERT INTO event_log (event_name, event_id, source, src, funnel_id, http_status, payload, plataforma)
         VALUES ('InitiateCheckout',$1,'server',$2,$3,$4,$5,'meta')`,
        [click.sck, click.src || null, f.id, status, JSON.stringify(payload)]);
    } catch (e) {
      console.error('CAPI_IC_FALHOU', JSON.stringify({ etapa: 'event_log', pixel: f.pixel_id, erro: String(e).slice(0, 200) }));
    }
  }
  return { enviados: funnels.length, aceitos };
}

// Mesmo desenho do IC da Meta, para os pixels TikTok do dominio. funnelId e
// o funil resolvido no /collect (o event_log e por funil; o pixel TikTok e por
// dominio). Kill switch: TIKTOK_EVENTS_DESLIGADO=1.
async function enviarICTikTok(pool, { dominio, funnelId, click }) {
  if (process.env.TIKTOK_EVENTS_DESLIGADO === '1') return { enviados: 0, aceitos: 0, desligado: true };
  if (!click || !click.sck || !dominio) return { enviados: 0, aceitos: 0 };
  let pixels = [];
  try {
    const r = await pool.query('SELECT * FROM tiktok_pixels WHERE active AND domain = $1', [dominio]);
    pixels = r.rows || [];
  } catch (e) {
    console.error('TIKTOK_FALHOU', JSON.stringify({ etapa: 'pixels', dominio, erro: String(e).slice(0, 200) }));
    return { enviados: 0, aceitos: 0 };
  }
  if (!pixels.length) return { enviados: 0, aceitos: 0 };
  let aceitos = 0;
  for (const px of pixels) {
    let status = 0; let payload = null;
    try {
      const r = await tiktok.sendInitiateCheckout({ pixel: px, click });
      status = r.httpStatus; payload = r.payload;
      // TikTok rejeita com HTTP 200 + code != 0.
      const rejeitado = !!(r.response && r.response.code);
      if (status === 200 && !rejeitado) aceitos++;
      else console.error('TIKTOK_FALHOU', JSON.stringify({ pixel: px.pixel_code, sck: click.sck, status, resp: r.response }));
      if (rejeitado) status = 0;
    } catch (e) {
      console.error('TIKTOK_FALHOU', JSON.stringify({ pixel: px.pixel_code, sck: click.sck, erro: String(e).slice(0, 200) }));
    }
    try {
      await pool.query(
        `INSERT INTO event_log (event_name, event_id, source, src, funnel_id, http_status, payload, plataforma)
         VALUES ('InitiateCheckout',$1,'server',$2,$3,$4,$5,'tiktok')`,
        [click.sck, click.src || null, funnelId || null, status, payload ? JSON.stringify(payload) : null]);
    } catch (e) {
      console.error('TIKTOK_FALHOU', JSON.stringify({ etapa: 'event_log', pixel: px.pixel_code, erro: String(e).slice(0, 200) }));
    }
  }
  return { enviados: pixels.length, aceitos };
}

module.exports = { enviarIC, enviarICTikTok };
