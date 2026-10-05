# TikTok Ads — eventos (pixel + Events API) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pixel TikTok no header, `ttclid`/`_ttp` no clique, `InitiateCheckout` e `CompletePayment` pela Events API com `external_id`, vários pixels por domínio, cadastro e cobertura no dashboard.

**Architecture:** Espelho da Meta. No tracking: tabela `tiktok_pixels`, módulo `tiktok.js` (construtores + envio), loop TikTok em `vendas.js` depois do da Meta, IC TikTok em `ic.js` disparado do `/collect`, `event_log.plataforma`. No dashboard: cadastro de pixel por domínio, bloco `ttq` no header por âncora, flag `send_to_tiktok`, aba **Plataformas**.

**Tech Stack:** tracking — Node/Express, CommonJS, `pg`, `node --test`. dashboard — Next.js, Prisma, `pg` via `query`/`writeQuery`, `node:test` com `tsx`.

## Global Constraints

- **Sistema EM PRODUÇÃO.** `/collect` e `vendas.js` são caminhos vivos de 10 funis. Nada da TikTok pode atrasar a resposta do `/collect`, alterar o que vai para a Meta, nem derrubar uma venda se a TikTok falhar.
- Nenhuma dependência npm nova, nos dois repositórios.
- Tracking: CommonJS, `npm test`, comentários **sem acento**, `||` ≠ `??` de propósito. Testes sem rede e sem banco (pool falso, `fetch` falso).
- Dashboard: `npm run check` **e `npx next build`** (o check não empacota para o navegador; foi assim que um import de `pg` num client component quebrou o deploy). Mensagens em português acentuado. Leitura do tracking só por `query`; escrita só por `writeQuery`/`writeTransaction`. `diag-funis.ts` untracked — não commitar.
- **Header só-Meta continua byte a byte igual ao fixture.** Tudo da TikTok entra por âncora, só quando há pixel TikTok no domínio.
- `event_id` do IC TikTok = `sck` cru (igual ao `event_id` do pixel); do `CompletePayment` = `'purchase_' + transaction_id`.
- Hash SHA-256 de valor normalizado: e-mail minúsculo sem espaços; telefone E.164 **com `+`**; `external_id = hash(sck)`.
- Nenhum banco alcançável da máquina de desenvolvimento.
- Baselines: tracking **98 passando**; dashboard **497 / 476 passando / 21 skips / 0**.

---

## Contexto verificado no código

- `capi.js` exporta `hash` (sha256 de `trim().toLowerCase()`), `fbcDe`, `userDataBase`, construtores e `sendEvent`. `geo.js` exporta `normTelefone` (só dígitos, `55` na frente de 10–11 dígitos, **sem `+`**).
- `normalize.js:74-82`: `CLICK_KEYS = ['gclid','gbraid','wbraid']`, `clickIds(b)` devolve string ≤200 ou `null`.
- `server.js /collect`: `INSERT INTO clicks (... placement, funnel_id, gclid, gbraid, wbraid) VALUES ($1..$21) RETURNING *`; `res.json({ ok: true })`; depois `setImmediate(() => enviarIC(pool, { dominio: funnel.domain, click: clickRow }).catch(...))`.
- `ic.js`: `enviarIC(pool, { dominio, click })` lê `funnels WHERE active AND domain`, um IC por pixel, grava `event_log (event_name, event_id, source, src, funnel_id, http_status, payload)`; kill switch `CAPI_IC_DESLIGADO`.
- `vendas.js:38-50`: `sendToMeta` nasce `true`; lookup `SELECT pr.offer_type, pr.send_to_meta, f.* FROM products pr JOIN funnels f ...`; `:57` `if (venda.enviarMeta === false) sendToMeta = false;`. `:158-200` loop da CAPI por `funnels` do domínio, `event_log` no sucesso e no `catch` (status 0, payload null), `UPDATE sales SET capi_sent, capi_response`.
- `test/vendas.test.js`: `fakePool({storeRow})`, `fakePoolComFunil({storeRow, clickRow})` (funil `{id:1, slug:'x-fb1', domain:'x.com', pixel_id:'123', capi_token:'tok', currency:'BRL'}`), `fakePoolComSlug()`; `insertSalesArgs(calls)`.
- Dashboard `header.ts`: `TEMPLATE_1_PIXEL` com bloco 0 (`window.__sck`), bloco `fbq` (`fbq('init', '{{PIXEL_ID}}', { external_id: window.__sck }); fbq('track', 'PageView');`), bloco capture. Âncoras existentes: `ANCORA_PIXEL_FIM = "fbq('track', 'PageView');\n</script>\n<script>"`, `ANCORA_FBCLID = "  var fbclid = getParam('fbclid') || '';\n"`, `ANCORA_PROPAGA`, `ANCORA_IC = "    try { if (window.fbq) fbq('track', 'InitiateCheckout', {}, { eventID: sck }); } catch (e) {}\n"`, `ANCORA_PAYLOAD = "      page_location: window.location.href, user_agent: navigator.userAgent, utms: utms };"`; `assertUmaVez`; `gerarHeader({ dominio, pixels, plataforma, google })`; `validarHeader` com `google: ... | null`. Testes contam blocos: 3 sem Google, 4 com.
- Dashboard `funis-service.ts`: `produtoSchema` exportado (`sendToMeta`, `sendToGoogle`), `FunilTrackingDetalhe.produtos[]`, `ProdutoDoFunil`, dois `INSERT INTO products (... send_to_meta, send_to_google, active)`, `writeQuery` ex. em `definirFunilAtivo`. `actions.ts`: `coletarProdutos` lê `produto${i}Meta/Google`; `criarProduto` lê `sendToMeta/sendToGoogle`; padrão `try { await assertGestor() ... } catch (e) { return falha(e) }`, `revalidatePath("/admin/tracking")`.
- Dashboard `funil-card.tsx`: abas `header | meta | produtos | editar`; `AbaMeta({ cobertura })` com `CAMPOS_META`, `ROTULO_CAMPO`, `SEM_DADO_NO_IC`, `Th`/`Td`; `AbaProdutos` com checkboxes `sendToMeta`/`sendToGoogle` e estados `enviarMeta`/`enviarGoogle`; `novo-funil-form.tsx` com `produto${i}Meta/Google`.
- Dashboard `cobertura-meta.ts` (puro): `CAMPOS_META`, `coberturaUserData(rows)` lê `payload.user_data`, `juntarContagens`, `AMOSTRA_POR_EVENTO`; `cobertura-meta-db.ts`: `getCoberturaMeta(funnelIds)` com contagem SQL + amostra por evento. `page.tsx:68-80` calcula por domínio dentro do try do tracking; `:105-125` monta `dominios[]` e chama `gerarHeader`.
- SETUP.md Fase 2 tem o `GRANT` do `dashboard_rw` (`GRANT SELECT, INSERT, UPDATE ON funnels, products` + sequence). Última fase: 8.

---

## Estrutura de arquivos

| repo | arquivo | responsabilidade |
|---|---|---|
| tracking | `normalize.js`, `server.js` | `ttclid`/`ttp` no clique; IC TikTok agendado |
| tracking | `tiktok.js`, `test/tiktok.test.js` | construtores e envio Events API |
| tracking | `vendas.js`, `test/vendas.test.js` | loop TikTok, `send_to_tiktok`, `event_log.plataforma` |
| tracking | `ic.js`, `test/ic.test.js` | `enviarICTikTok` |
| tracking | `README.md`, `HANDOFF.md` | SQL pré-deploy, variáveis, verificação |
| dashboard | `src/lib/tracking/tiktok-pixels.ts`, `tests/tiktok-pixels.test.ts` | validação + CRUD de pixels |
| dashboard | `src/lib/tracking/funis-service.ts`, `actions.ts`, `funil-card.tsx`, `novo-funil-form.tsx` | `sendToTikTok`; aba TikTok |
| dashboard | `src/lib/tracking/header.ts`, `tests/header.test.ts` | bloco `ttq` por âncora |
| dashboard | `src/lib/tracking/cobertura-meta.ts`, `cobertura-meta-db.ts`, `tests/cobertura-meta.test.ts` | cobertura por plataforma |
| dashboard | `src/app/admin/tracking/page.tsx` | pixels por domínio → header, aba |
| dashboard | `SETUP.md` | fase do operador |

---

## Task 1: `ttclid` e `ttp` no clique (tracking)

**Files:**
- Modify: `normalize.js`, `server.js`
- Test: `test/normalize.test.js`

- [ ] **Step 1: Testes que falham** — acrescentar em `test/normalize.test.js`:

```js
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
```

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: Implementar**

`normalize.js`: `CLICK_KEYS = ['gclid', 'gbraid', 'wbraid', 'ttclid'];` (comentário: `ttclid` e o id de clique do TikTok Ads, na URL de entrada). Acrescentar:

```js
// Cookie _ttp do pixel do TikTok, lido pelo header e mandado no /collect.
// Nao e id de clique (nao vem na URL): e o id do navegador, como o _fbp.
function ttpDe(b) {
  const v = b && typeof b.ttp === 'string' ? b.ttp.trim() : '';
  return v ? v.slice(0, 200) : null;
}
module.exports = { normalizeUtms, deepDecode, splitNameId, cleanSource, clickIds, ttpDe };
```

`server.js`: importar `ttpDe`; no `/collect`, o `INSERT INTO clicks` ganha `, ttclid, ttp` na lista de colunas e `,$22,$23` nos valores, com `g.ttclid, ttpDe(b)` no fim dos parâmetros. Nada mais.

- [ ] **Step 4: Ver passar** — `node --check server.js && npm test` (98 + 2 = 100).

- [ ] **Step 5: Commit** — `git commit -m "feat: /collect grava ttclid e ttp em clicks"`

---

## Task 2: `tiktok.js` — construtores e envio (tracking)

**Files:**
- Create: `tiktok.js`
- Test: `test/tiktok.test.js`

**Interfaces:**
- Consumes: `hash` de `./capi`, `normTelefone` de `./geo`.
- Produces: `buildCompletePaymentEvent({ pixel, sale, store, click })`, `buildInitiateCheckoutEvent({ pixel, click })`, `sendTikTokEvent({ pixel, event })` → `{ httpStatus, response, payload }`, `sendCompletePayment`, `sendInitiateCheckout`. `pixel` é a linha de `tiktok_pixels` (`pixel_code`, `access_token`).

- [ ] **Step 1: Testes que falham** — `test/tiktok.test.js`:

```js
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
```

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: Criar `tiktok.js`**

```js
// =====================================================================
//  tiktok.js — Cliente da TikTok Events API (v1.3).
//  Espelho do capi.js para a TikTok: dois eventos, InitiateCheckout (do
//  /collect, event_id = sck, deduplica com o pixel em 48h) e CompletePayment
//  (do webhook, event_id = purchase_<tx>). `user` leva o que a TikTok pesa na
//  correspondencia: ttclid (id de clique), ttp (cookie), ip, user agent,
//  e-mail/telefone/external_id em SHA-256.
//  O pixel da TikTok mora em tiktok_pixels (varios por dominio), nao em funnels.
// =====================================================================
const { hash } = require('./capi');
const { normTelefone } = require('./geo');

const EVENTS_API = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

// A TikTok pede E.164 com o '+'; normTelefone ja poe o codigo do pais.
function telefoneE164(v) {
  const d = normTelefone(v);
  return d ? '+' + d : undefined;
}

function segundos(d) {
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 1000);
}

// identificadores do navegador, comuns aos dois eventos
function userBase({ store, click, sck }) {
  return {
    external_id: sck ? hash(sck) : undefined,
    ttclid: click?.ttclid || undefined,
    ttp: click?.ttp || undefined,
    ip: store?.ip_override || click?.ip || undefined,
    user_agent: store?.user_agent || click?.user_agent || undefined,
  };
}

function buildCompletePaymentEvent({ pixel, sale, store, click }) {
  const user = clean({
    email: hash(sale.customer_email),
    phone: hash(telefoneE164(sale.customer_phone)),
    ...userBase({ store, click, sck: sale.sck || store?.sck }),
  });
  const properties = clean({
    value: Number(sale.value) || 0,
    currency: sale.currency || 'BRL',
    content_type: 'product',
    order_id: sale.transaction_id,
    contents: sale.product_code
      ? [clean({ content_id: sale.product_code, content_name: sale.product_name || undefined, quantity: 1, price: Number(sale.value) || 0 })]
      : undefined,
  });
  return clean({
    event: 'CompletePayment',
    event_time: sale.event_time || Math.floor(Date.now() / 1000),
    event_id: 'purchase_' + sale.transaction_id,
    user,
    properties,
    page: clean({ url: store?.page_location || click?.landing_url || undefined }),
  });
}

// A TikTok exige user_agent em evento de site; sem sck nao ha event_id.
function buildInitiateCheckoutEvent({ pixel, click }) {
  if (!click || !click.sck || !click.user_agent) return null;
  return clean({
    event: 'InitiateCheckout',
    event_time: segundos(click.created_at || Date.now()),
    event_id: click.sck,
    user: clean(userBase({ store: null, click, sck: click.sck })),
    page: clean({ url: click.landing_url || undefined }),
  });
}

async function sendTikTokEvent({ pixel, event }) {
  const body = { event_source: 'web', event_source_id: pixel.pixel_code, data: [event] };
  // So para a aba Test Events; em producao fica vazio (evento de teste nao otimiza).
  const teste = (process.env.TIKTOK_TEST_EVENT_CODE || '').trim();
  if (teste) body.test_event_code = teste;
  const res = await fetch(EVENTS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Access-Token': pixel.access_token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, response: json, payload: event };
}

async function sendCompletePayment({ pixel, sale, store, click }) {
  return sendTikTokEvent({ pixel, event: buildCompletePaymentEvent({ pixel, sale, store, click }) });
}

async function sendInitiateCheckout({ pixel, click }) {
  const event = buildInitiateCheckoutEvent({ pixel, click });
  if (!event) return { httpStatus: 0, response: { skipped: 'sem_sck_ou_user_agent' }, payload: null };
  return sendTikTokEvent({ pixel, event });
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

module.exports = {
  buildCompletePaymentEvent, buildInitiateCheckoutEvent,
  sendTikTokEvent, sendCompletePayment, sendInitiateCheckout, telefoneE164,
};
```

Atenção ao `clean`: remove objeto vazio (`page: {}` quando não há URL) — o teste "sem e-mail" espera `contents` ausente, e `page` ausente quando não há url.

- [ ] **Step 4: Ver passar** — `npm test` (100 + 6 = 106).

- [ ] **Step 5: Commit** — `git commit -m "feat: tiktok.js — CompletePayment e InitiateCheckout pela Events API"`

---

## Task 3: Venda vai para os pixels TikTok do domínio (tracking)

**Files:**
- Modify: `vendas.js`, `ic.js` (só o `INSERT` do `event_log`)
- Test: `test/vendas.test.js`

**Interfaces:**
- Consumes: `sendCompletePayment` de `./tiktok`.
- Produces: `processarVenda` manda `CompletePayment` para `tiktok_pixels WHERE active AND domain = funnel.domain` quando `paid && sendToTikTok`; grava `event_log` com `plataforma = 'tiktok'`; os `INSERT`s da Meta passam a nomear `plataforma = 'meta'`.

- [ ] **Step 1: Testes que falham** — em `test/vendas.test.js`, estender `fakePoolComFunil` com `tiktokRows` (default `[]`): `if (text.includes('FROM tiktok_pixels')) return { rows: tiktokRows };` e, no lookup de produto, aceitar `produtoRow` opcional: `if (text.includes('FROM products pr')) return { rows: produtoRow ? [produtoRow] : [] };`. Depois:

```js
test('venda paga vai para cada pixel TikTok do dominio, com plataforma tiktok no event_log', async (t) => {
  const fetchOriginal = global.fetch; const urls = [];
  global.fetch = async (url, opts) => { urls.push({ url, body: JSON.parse(opts.body) }); return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePoolComFunil({
    storeRow: { src: 'tt', fbp: 'fb.1.1.2' },
    clickRow: { sck: 'idx_abc', ttclid: 'E.C.P.x', ttp: 't1', ip: '5.5.5.5', user_agent: 'UA', created_at: new Date() },
    tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1', domain: 'x.com', active: true },
                 { id: 2, pixel_code: 'CA2', access_token: 'k2', domain: 'x.com', active: true }],
  });
  const venda = { txId: 'T7', sck: 'idx_abc', src: 'tt', paid: true, value: 50, total: 50, origem: 'payt', email: 'a@b.com' };
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
    produtoRow: { offer_type: 'principal', send_to_meta: true, send_to_tiktok: false, id: 1, slug: 'x-fb1', domain: 'x.com', pixel_id: '123', capi_token: 'tok', currency: 'BRL', active: true },
  });
  await processarVenda(pool, { txId: 'T8', sck: 'idx_abc', paid: true, value: 10, total: 10, origem: 'payt', productCode: 'P1' });
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
  });
  const r = await processarVenda(pool, { txId: 'T9', sck: 'idx_abc', paid: true, value: 10, total: 10, origem: 'payt' });
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
  const pool = fakePoolComFunil({ storeRow: null, clickRow: null, tiktokRows: [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }] });
  await processarVenda(pool, { txId: 'ds24a_1', funnelSlug: 'x-fb1', sck: null, paid: true, value: 10, total: 10, enviarMeta: false, origem: 'digistore24_afiliado' });
  assert.strictEqual(urls.length, 0);
});
```

Nota: o `fakePoolComFunil` precisa também responder `WHERE active AND slug = $1` com o `funnelRow` para o último teste (acrescente essa linha à fixture).

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: `vendas.js`**

Import: `const { sendCompletePayment } = require('./tiktok');`.

Lookup do produto: `SELECT pr.offer_type, pr.send_to_meta, pr.send_to_tiktok, f.* FROM products pr ...`. Logo após `let sendToMeta = true;`:

```js
  // TikTok: produto NAO cadastrado nao vai (o upload nao se desfaz; omissao e o
  // lado seguro). Cadastrado, segue send_to_tiktok.
  let sendToTikTok = false;
```

Dentro do `if (pr.rows[0])`: `sendToTikTok = pr.rows[0].send_to_tiktok === true;`. Depois da linha terminal do `enviarMeta`: `if (venda.enviarMeta === false) sendToTikTok = false;`.

Nos dois `INSERT INTO event_log` da Meta no loop da CAPI: colunas `(event_name, event_id, source, src, funnel_id, http_status, payload, plataforma)` e `VALUES ('Purchase',$1,'server',$2,$3,$4,$5,'meta')`.

Depois do bloco `if (paid && funnels.length && sendToMeta) { ... return ... }` **não** pode ficar — o `return` dentro dele impede a TikTok. Reestruturar o fim da função assim: o bloco da Meta deixa de dar `return` e guarda `let motivo = ...`; a TikTok vem em seguida; o `return` final usa o motivo da Meta. Concretamente:

```js
  let motivoMeta = null;
  if (paid && funnels.length && sendToMeta) {
    ... (loop da CAPI como esta, incluindo o UPDATE sales) ...
    motivoMeta = null;
  } else if (paid && !sendToMeta) {
    await pool.query(`UPDATE sales SET capi_response=$1 WHERE transaction_id=$2`, ['{"skipped":"produto_nao_envia_meta"}', txId]);
    motivoMeta = 'produto_nao_envia_meta';
  } else if (paid && !funnels.length) {
    await pool.query(`UPDATE sales SET capi_response=$1 WHERE transaction_id=$2`, ['{"skipped":"funnel_nao_resolvido"}', txId]);
    motivoMeta = 'funnel_nao_resolvido';
  } else {
    motivoMeta = 'nao_pago';
  }

  // ---- TikTok: depois da Meta, nunca no caminho dela. Um CompletePayment por
  // pixel TikTok ativo do dominio; falha vira log e linha no event_log (status 0).
  if (paid && funnel && sendToTikTok && process.env.TIKTOK_EVENTS_DESLIGADO !== '1') {
    await enviarTikTokVenda(pool, { funnel, sale, store, click, srcFinal, txId });
  }

  return { ok: true, motivo: motivoMeta };
```

O objeto `sale` precisa existir fora do `if` da Meta: mova a construção do `sale` (o literal com `transaction_id, value, ...`) para **antes** do `let motivoMeta`, e acrescente `currency: funnel?.currency || 'BRL'` a ele (a TikTok precisa; a Meta ignora o campo extra). Helper no fim do arquivo:

```js
async function enviarTikTokVenda(pool, { funnel, sale, store, click, srcFinal, txId }) {
  let pixels = [];
  try {
    const r = await pool.query('SELECT * FROM tiktok_pixels WHERE active AND domain = $1', [funnel.domain]);
    pixels = r.rows || [];
  } catch (e) {
    console.error('TIKTOK_FALHOU', JSON.stringify({ etapa: 'pixels', tx: txId, erro: String(e).slice(0, 200) }));
    return;
  }
  for (const px of pixels) {
    let status = 0; let payload = null;
    try {
      const r = await sendCompletePayment({ pixel: px, sale, store, click });
      status = r.httpStatus; payload = r.payload;
      if (status !== 200 || (r.response && r.response.code && r.response.code !== 0)) {
        console.error('TIKTOK_FALHOU', JSON.stringify({ pixel: px.pixel_code, tx: txId, status, resp: r.response }));
      }
    } catch (e) {
      console.error('TIKTOK_FALHOU', JSON.stringify({ pixel: px.pixel_code, tx: txId, erro: String(e).slice(0, 200) }));
    }
    try {
      await pool.query(
        `INSERT INTO event_log (event_name, event_id, source, src, funnel_id, http_status, payload, plataforma)
         VALUES ('CompletePayment',$1,'server',$2,$3,$4,$5,'tiktok')`,
        ['purchase_' + txId, srcFinal, funnel.id, status, payload ? JSON.stringify(payload) : null]);
    } catch (e) {
      console.error('TIKTOK_FALHOU', JSON.stringify({ etapa: 'event_log', pixel: px.pixel_code, erro: String(e).slice(0, 200) }));
    }
  }
}
```

**Não-regressão da Meta:** os testes existentes de `vendas.test.js` continuam verdes — o `return { ok, motivo }` devolve os mesmos motivos de antes (`null`, `'produto_nao_envia_meta'`, `'funnel_nao_resolvido'`, `'nao_pago'`, `'teste'`).

`ic.js`: o `INSERT INTO event_log` do IC da Meta ganha `, plataforma` e `,'meta'`.

- [ ] **Step 4: Ver passar** — `npm test` (106 + 4 = 110).

- [ ] **Step 5: Commit** — `git commit -m "feat: CompletePayment para os pixels TikTok do dominio; event_log.plataforma"`

---

## Task 4: IC TikTok a partir do `/collect` (tracking)

**Files:**
- Modify: `ic.js`, `server.js`
- Test: `test/ic.test.js`

- [ ] **Step 1: Testes que falham** — em `test/ic.test.js` (a fixture `fakePool(funnels)` existe; acrescente um segundo argumento `tiktokRows = []` respondendo `FROM tiktok_pixels`):

```js
const { enviarICTikTok } = require('../ic');

test('IC TikTok: um por pixel do dominio, event_id = sck, plataforma tiktok', async (t) => {
  const fetchOriginal = global.fetch; const corpos = [];
  global.fetch = async (url, opts) => { corpos.push({ url, body: JSON.parse(opts.body) }); return { status: 200, json: async () => ({ code: 0 }) }; };
  t.after(() => { global.fetch = fetchOriginal; });
  const pool = fakePool([], [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }, { id: 2, pixel_code: 'CA2', access_token: 'k2' }]);
  const r = await enviarICTikTok(pool, { dominio: 'www.x.com', funnelId: 7, click: { ...click, ttclid: 'E.C.P.x', ttp: 't1' } });
  assert.deepStrictEqual(r, { enviados: 2, aceitos: 2 });
  assert.ok(corpos.every(c => c.url.includes('business-api.tiktok.com')));
  assert.strictEqual(corpos[0].body.data[0].event_id, 'idx_abc');
  const logs = pool.calls.filter(c => c.text.includes('INSERT INTO event_log'));
  assert.strictEqual(logs.length, 2);
  assert.ok(logs[0].text.includes("'tiktok'"));
  assert.strictEqual(logs[0].params[2], 7);
});

test('IC TikTok: TIKTOK_EVENTS_DESLIGADO=1 desliga; sem pixel nao manda', async (t) => {
  process.env.TIKTOK_EVENTS_DESLIGADO = '1';
  t.after(() => { delete process.env.TIKTOK_EVENTS_DESLIGADO; });
  const pool = fakePool([], [{ id: 1, pixel_code: 'CA1', access_token: 'k1' }]);
  assert.deepStrictEqual(await enviarICTikTok(pool, { dominio: 'www.x.com', funnelId: 7, click }), { enviados: 0, aceitos: 0, desligado: true });
  delete process.env.TIKTOK_EVENTS_DESLIGADO;
  assert.deepStrictEqual(await enviarICTikTok(fakePool([], []), { dominio: 'www.x.com', funnelId: 7, click }), { enviados: 0, aceitos: 0 });
});
```

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: `ic.js`** — acrescentar (import `const tiktok = require('./tiktok');`):

```js
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
      if (status === 200 && !(r.response && r.response.code)) aceitos++;
      else console.error('TIKTOK_FALHOU', JSON.stringify({ pixel: px.pixel_code, sck: click.sck, status, resp: r.response }));
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
```

Nota sobre `aceitos`: a TikTok devolve HTTP 200 com `code != 0` em erro de validação — por isso o `code` conta.

`server.js`: importar `enviarICTikTok`; dentro do mesmo `setImmediate`, depois da chamada da Meta:

```js
        enviarICTikTok(pool, { dominio: funnel.domain, funnelId: funnel.id, click: clickRow })
          .catch((e) => console.error('TIKTOK_FALHOU', JSON.stringify({ etapa: 'setImmediate', erro: String(e).slice(0, 200) })));
```

- [ ] **Step 4: Ver passar** — `node --check server.js && npm test` (110 + 2 = 112).

- [ ] **Step 5: Commit** — `git commit -m "feat: InitiateCheckout TikTok pela Events API a partir do /collect"`

---

## Task 5: Runbook do tracking

**Files:**
- Modify: `HANDOFF.md`, `README.md`

- [ ] **Step 1: HANDOFF** — item novo **no topo** do checklist pré-deploy (renumerar os demais e conferir referências "item N" no arquivo), no formato dos existentes, com os cinco comandos, nesta ordem, todos **antes** do deploy do tracking e do dashboard:

```
node scripts/q.js "CREATE TABLE IF NOT EXISTS tiktok_pixels (id SERIAL PRIMARY KEY, domain TEXT NOT NULL, pixel_code TEXT NOT NULL, access_token TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (domain, pixel_code))"
node scripts/q.js "ALTER TABLE clicks ADD COLUMN IF NOT EXISTS ttclid TEXT, ADD COLUMN IF NOT EXISTS ttp TEXT"
node scripts/q.js "ALTER TABLE products ADD COLUMN IF NOT EXISTS send_to_tiktok BOOLEAN NOT NULL DEFAULT true"
node scripts/q.js "UPDATE products SET send_to_tiktok = COALESCE(send_to_meta, true)"
node scripts/q.js "ALTER TABLE event_log ADD COLUMN IF NOT EXISTS plataforma TEXT NOT NULL DEFAULT 'meta'"
node scripts/q.js "GRANT SELECT, INSERT, UPDATE ON tiktok_pixels TO dashboard_rw"
node scripts/q.js "GRANT USAGE, SELECT ON SEQUENCE tiktok_pixels_id_seq TO dashboard_rw"
```

Texto: por que antes (o `INSERT` de `clicks` e os de `event_log` nomeiam as colunas novas; sem elas, todo clique e toda venda falham ao gravar), por que é seguro antes (código atual ignora coluna que não conhece; `DEFAULT 'meta'` preenche o histórico). Rollback: `TIKTOK_EVENTS_DESLIGADO=1` + restart desliga os envios sem deploy; as colunas podem ficar.

Seção nova "TikTok — eventos (pixel + Events API)", antes de "Pendências conhecidas", com: variáveis (`TIKTOK_TEST_EVENT_CODE`, `TIKTOK_EVENTS_DESLIGADO`), prefixo `TIKTOK_FALHOU`, o que o dashboard cadastra (token do Events Manager por pixel), verificação (*Test Events* por minutos, só IC; `CompletePayment` conferido no `event_log` da primeira venda: `node scripts/q.js "SELECT payload FROM event_log WHERE plataforma='tiktok' AND event_name='CompletePayment' ORDER BY id DESC LIMIT 1"`), e o aviso de que o código de teste afeta todos os pixels TikTok.

- [ ] **Step 2: README** — tabela de variáveis: `TIKTOK_TEST_EVENT_CODE` (não; aba Test Events; vazio em produção) e `TIKTOK_EVENTS_DESLIGADO` (não; `1` desliga IC e CompletePayment da TikTok; kill switch). Rotas: `/collect` também dispara IC TikTok; webhooks também mandam `CompletePayment`. Runbook: `TIKTOK_FALHOU`.

- [ ] **Step 3: Commit** — `git commit -m "docs: SQL pre-deploy, variaveis e verificacao do TikTok"`

---

## Task 6: Pixels TikTok e `sendToTikTok` no dashboard

**Files:**
- Create: `src/lib/tracking/tiktok-pixels.ts`, `tests/tiktok-pixels.test.ts`
- Modify: `src/lib/tracking/funis-service.ts`, `src/app/admin/tracking/actions.ts`, `src/app/admin/tracking/funil-card.tsx`, `src/app/admin/tracking/novo-funil-form.tsx`, `tests/produto-schema.test.ts`

**Interfaces:**
- Produces: `validarPixelTikTok({ pixelCode, accessToken })` pura; `listarPixelsTikTok()` → `PixelTikTok[]` (`id, domain, pixelCode, active` — **sem token**); `adicionarPixelTikTok({ domain, pixelCode, accessToken })`; `definirPixelTikTokAtivo(id, ativo)`. `produtoSchema` com `sendToTikTok`; `FunilTrackingDetalhe.produtos[].sendToTikTok`, `ProdutoDoFunil.sendToTikTok`. Actions `criarPixelTikTok`, `alternarPixelTikTok`.

- [ ] **Step 1: Testes que falham**

`tests/tiktok-pixels.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { validarPixelTikTok } from "../src/lib/tracking/tiktok-pixels";

test("validarPixelTikTok aceita código e token no formato", () => {
  assert.equal(validarPixelTikTok({ pixelCode: "CABC123DEF456", accessToken: "a".repeat(40) }), null);
});
test("validarPixelTikTok recusa código ou token fora do formato, nomeando o campo", () => {
  assert.match(validarPixelTikTok({ pixelCode: "", accessToken: "a".repeat(40) })!, /pixel/i);
  assert.match(validarPixelTikTok({ pixelCode: "com espaço", accessToken: "a".repeat(40) })!, /pixel/i);
  assert.match(validarPixelTikTok({ pixelCode: "CABC123", accessToken: "curto" })!, /token/i);
});
```

Em `tests/produto-schema.test.ts`, trocar o teste "exige sendToGoogle" por um que exige os três e aceita os três independentes (`sendToTikTok: false` com os outros `true`).

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: `src/lib/tracking/tiktok-pixels.ts`**

```ts
import { query } from "@/lib/tracking/db";
import { writeQuery } from "@/lib/tracking/write";
import { normalizarDominio } from "@/lib/tracking/slug";

export type PixelTikTok = { id: number; domain: string; pixelCode: string; active: boolean };

/** Pura. O código do pixel é alfanumérico (ex. CABC123…); o token do Events Manager é longo. */
export function validarPixelTikTok(e: { pixelCode: string; accessToken: string }): string | null {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(e.pixelCode.trim())) return "Código do pixel TikTok inválido: só letras e números, como aparece no Events Manager.";
  if (e.accessToken.trim().length < 20) return "Token de acesso curto demais — gere em Events Manager › pixel › Settings › Generate Access Token.";
  return null;
}

/** Nunca devolve o token: a tela não precisa dele e ele não tem por que trafegar. */
export async function listarPixelsTikTok(): Promise<PixelTikTok[]> {
  const rows = await query<{ id: number; domain: string; pixel_code: string; active: boolean }>(
    `SELECT id, domain, pixel_code, active FROM tiktok_pixels ORDER BY domain, id`,
  );
  return rows.map((r) => ({ id: r.id, domain: r.domain, pixelCode: r.pixel_code, active: r.active }));
}

export async function adicionarPixelTikTok(e: { domain: string; pixelCode: string; accessToken: string }): Promise<void> {
  const problema = validarPixelTikTok(e);
  if (problema) throw new Error(problema);
  const domain = normalizarDominio(e.domain);
  if (!domain) throw new Error("Domínio vazio.");
  await writeQuery(
    `INSERT INTO tiktok_pixels (domain, pixel_code, access_token, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (domain, pixel_code) DO UPDATE SET access_token = EXCLUDED.access_token, active = true`,
    [domain, e.pixelCode.trim(), e.accessToken.trim()],
  );
}

/** Desativar é `active = false`; não há DELETE no GRANT. */
export async function definirPixelTikTokAtivo(id: number, ativo: boolean): Promise<void> {
  const linhas = await writeQuery<{ id: number }>(`UPDATE tiktok_pixels SET active = $2 WHERE id = $1 RETURNING id`, [id, ativo]);
  if (linhas.length === 0) throw new Error(`Pixel TikTok ${id} não encontrado.`);
}
```

Atenção ao domínio: `funnels.domain` hoje é guardado **sem** `www.` (há um `normalizarDominiosNoTracking` que tirou) — `normalizarDominio` mantém o que vier; a página passa o `domain` do card, então o texto casa com o que o tracking consulta (`WHERE domain = funnel.domain`).

- [ ] **Step 4: `sendToTikTok` ponta a ponta** — exatamente o que foi feito para `sendToGoogle`: `produtoSchema` (`sendToTikTok: z.boolean()`), tipos, `SELECT` de produtos (`send_to_tiktok`), os dois `INSERT INTO products` (coluna, placeholder, parâmetro, e `send_to_tiktok = EXCLUDED.send_to_tiktok` no `ON CONFLICT`), `coletarProdutos` (`produto${i}TikTok`), `criarProduto` (`sendToTikTok`), checkbox "TikTok" ao lado de "Google" em `funil-card.tsx` (estado `enviarTikTok`, mesmo padrão ligado em `principal`) e em `novo-funil-form.tsx` (campo `tiktok` na linha, coluna na tabela de já cadastrados).

- [ ] **Step 5: Actions** — em `actions.ts`:

```ts
export async function criarPixelTikTok(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    await assertGestor();
    await adicionarPixelTikTok({
      domain: String(formData.get("domain") ?? ""),
      pixelCode: String(formData.get("pixelCode") ?? ""),
      accessToken: String(formData.get("accessToken") ?? ""),
    });
    revalidatePath("/admin/tracking");
    return { ok: true, message: "Pixel TikTok cadastrado. Recole o header do domínio." };
  } catch (e) {
    return falha(e);
  }
}

export async function alternarPixelTikTok(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    await assertGestor();
    const id = Number(formData.get("id"));
    const ativo = formData.get("ativo") === "1";
    await definirPixelTikTokAtivo(id, ativo);
    revalidatePath("/admin/tracking");
    return { ok: true, message: ativo ? "Pixel reativado." : "Pixel desativado. Recole o header do domínio." };
  } catch (e) {
    return falha(e);
  }
}
```

`falha(e)` nunca ecoa o token: ele só aparece no `FormData`, não na mensagem de erro — conferir que `falha` devolve `e.message` e que nenhuma mensagem de `tiktok-pixels.ts` inclui o valor.

- [ ] **Step 6: Aba TikTok no card** — prop `pixelsTikTok: PixelTikTok[]` em `FunilTrackingCard`; aba `"tiktok"` rotulada **TikTok** depois de "Meta". `AbaTikTok({ domain, pixels, podeEscrever })`: lista (código, badge ativo/inativo, botão "Desativar"/"Reativar" com `alternarPixelTikTok`), formulário `criarPixelTikTok` com `domain` oculto, `pixelCode` (`Input` placeholder `CABC123…`), `accessToken` (`Input type="password" autoComplete="off"`, hint: "Events Manager › pixel › Settings › Generate Access Token. Um token por pixel. Não aparece depois de salvo."), `Feedback`. Texto no topo: "Vários pixels por domínio. Todo pixel ativo recebe PageView, IC e CompletePayment; o header precisa ser recolado depois de cadastrar ou desativar."

- [ ] **Step 7: `page.tsx`** — carregar `listarPixelsTikTok()` dentro do mesmo `try` do tracking (é leitura do tracking), agrupar por `domain`, passar `pixelsTikTok={...}` ao card. (O header vem na Task 7.)

- [ ] **Step 8: Verificar** — `npm run check && npx next build` (497 + 2 novos − 0 = 499 esperados; o teste de `produto-schema` trocado conta igual).

- [ ] **Step 9: Commit** — `git commit -m "feat: pixels TikTok por dominio (cadastro, aba no card) e send_to_tiktok no produto"`

---

## Task 7: Header com pixel TikTok (dashboard)

**Files:**
- Modify: `src/lib/tracking/header.ts`, `src/app/admin/tracking/page.tsx`
- Test: `tests/header.test.ts`

**Interfaces:**
- Produces: `gerarHeader({ ..., tiktok?: { pixels: string[] } })`; `validarHeader(..., tiktok: { pixels: string[] } | null)`.

- [ ] **Step 1: Testes que falham** — em `tests/header.test.ts`:

```ts
const TIKTOK = { pixels: ["CABC123DEF"] };

test("sem TikTok, a saída continua byte a byte com o fixture", () => {
  const a = gerarHeader({ dominio: "prazeremcena.com", pixels: ["123456789012345"] });
  assert.equal(a, oficial("1pixel.html").replaceAll("{{DOMAIN}}", "prazeremcena.com").replaceAll("{{PIXEL_ID}}", "123456789012345"));
  assert.ok(!a.includes("ttq"));
});

test("com TikTok: carregador, identify com o sck, load por pixel, page, captura, payload e IC no clique", () => {
  const html = gerarHeader({ dominio: "chemistrysystem.com", pixels: ["123456789012345"], plataforma: "digistore24", tiktok: { pixels: ["CA1", "CA2"] } });
  assert.ok(html.includes("analytics.tiktok.com/i18n/pixel/events.js"));
  assert.ok(html.includes("ttq.identify({ external_id: window.__sck });"));
  assert.equal((html.match(/ttq\.load\('[A-Za-z0-9_-]+'\);/g) ?? []).length, 2);
  assert.ok(html.indexOf("ttq.load('CA1')") < html.indexOf("ttq.load('CA2')"));
  assert.equal((html.match(/ttq\.page\(\);/g) ?? []).length, 1);
  assert.ok(html.includes("var ttclid = getParam('ttclid') || '';"));
  assert.ok(html.includes("if (ttclid) setCookie('c_ttclid', ttclid, TTL);"));
  assert.ok(html.includes("if (ttclid) propagate.ttclid = ttclid;"));
  assert.ok(html.includes("ttclid: ttclid, ttp: getCookie('_ttp') || '',"));
  assert.ok(html.includes("try { if (window.ttq) ttq.track('InitiateCheckout', {}, { event_id: sck }); } catch (e) {}"));
  // ordem: bloco 0 (sck) -> fbq -> ttq -> capture
  assert.ok(html.indexOf("window.__sck = sck;") < html.indexOf("ttq.identify") && html.indexOf("fbq('track', 'PageView')") < html.indexOf("ttq.load"));
  assert.ok(!html.includes("{{"));
  assert.equal([...html].filter((c) => c.codePointAt(0)! > 127).length, 0);
});

test("com TikTok e Google juntos: 5 blocos válidos, nessa ordem", () => {
  const html = gerarHeader({ dominio: "chemistrysystem.com", pixels: ["123456789012345"], plataforma: "digistore24", google: GOOGLE, tiktok: TIKTOK });
  const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(blocos.length, 5, "sck, fbq, ttq, gtag e capture");
  assert.ok(html.indexOf("ttq.load") < html.indexOf("gtag('config'"));
  const dir = mkdtempSync(join(tmpdir(), "header-tt-"));
  blocos.forEach((js, i) => { const f = join(dir, `b${i}.js`); writeFileSync(f, js); execFileSync(process.execPath, ["--check", f]); });
});

test("recusa pixel TikTok fora do formato ou lista vazia", () => {
  assert.throws(() => gerarHeader({ dominio: "x.com", pixels: ["123456789012345"], tiktok: { pixels: [] } }), HeaderInvalidoError);
  assert.throws(() => gerarHeader({ dominio: "x.com", pixels: ["123456789012345"], tiktok: { pixels: ["com espaço"] } }), HeaderInvalidoError);
});
```

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: `header.ts`**

Constantes novas (depois de `BLOCO_CAPTURA`):

```ts
/** Bloco do pixel TikTok, inserido logo depois do bloco da Meta (antes do Google, se houver). */
const BLOCO_TTQ = String.raw`<script>
!function (w, d, t) {
  w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script");n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};
  ttq.identify({ external_id: window.__sck });
{{TTQ_LOADS}}  ttq.page();
}(window, document, 'ttq');
</script>
`;

const BLOCO_TTCLID = String.raw`  var ttclid = getParam('ttclid') || '';
  if (ttclid) setCookie('c_ttclid', ttclid, TTL);
  ttclid = ttclid || getCookie('c_ttclid') || '';
`;
```

`HeaderInput` ganha `tiktok?: { pixels: string[] }`. Em `gerarHeader`, depois da validação do Google:

```ts
  if (tiktok) {
    if (!tiktok.pixels.length) throw new HeaderInvalidoError("informe ao menos um pixel TikTok.");
    for (const p of tiktok.pixels) if (!/^[A-Za-z0-9_-]{6,64}$/.test(p)) throw new HeaderInvalidoError(`pixel TikTok "${p}" inválido.`);
  }
```

Inserção, **antes** do bloco do Google (para a ordem fbq → ttq → gtag ficar certa a partir da mesma âncora):

```ts
  if (tiktok) {
    for (const a of [ANCORA_PIXEL_FIM, ANCORA_FBCLID, ANCORA_PROPAGA, ANCORA_IC, ANCORA_PAYLOAD]) assertUmaVez(html, a);
    const loads = tiktok.pixels.map((p) => `  ttq.load('${p}');\n`).join("");
    html = html
      .replace(ANCORA_PIXEL_FIM, "fbq('track', 'PageView');\n</script>\n" + BLOCO_TTQ.replace("{{TTQ_LOADS}}", loads) + "<script>")
      .replace(ANCORA_FBCLID, ANCORA_FBCLID + BLOCO_TTCLID)
      .replace(ANCORA_PROPAGA, ANCORA_PROPAGA + "  if (ttclid) propagate.ttclid = ttclid;\n")
      .replace(ANCORA_IC, ANCORA_IC + "    try { if (window.ttq) ttq.track('InitiateCheckout', {}, { event_id: sck }); } catch (e) {}\n")
      .replace(ANCORA_PAYLOAD, "      ttclid: ttclid, ttp: getCookie('_ttp') || '',\n" + ANCORA_PAYLOAD);
  }
```

Cuidado com a âncora `ANCORA_PIXEL_FIM`: depois da inserção da TikTok ela continua existindo **uma** vez (o `</script>\n<script>` que fecha o bloco `ttq` e abre o capture não começa com `fbq('track'…`), então o bloco do Google, inserido em seguida pela mesma âncora, entra **depois** do `ttq`. O `assertUmaVez` do Google confirma.

`validarHeader`: parâmetro `tiktok: { pixels: string[] } | null`; checagens: com `tiktok`, `ttq.load(` aparece `pixels.length` vezes, `ttq.page();` uma, `ttq.identify({ external_id: window.__sck });` uma, e o `ttq.track('InitiateCheckout'` uma; sem `tiktok`, nenhuma ocorrência de `ttq`.

`page.tsx`: `const tiktok = pixelsTikTokAtivosDoDominio.length ? { pixels: [...] } : undefined;` e `gerarHeader({ ..., tiktok })`. Só pixels **ativos** entram no header. A aba Header mostra uma linha a mais quando há TikTok: "Inclui N pixel(is) TikTok — page view, IC no clique e CompletePayment pelo servidor."

- [ ] **Step 4: Ver passar** — `npm run check && npx next build` (499 + 4 = 503).

- [ ] **Step 5: Commit** — `git commit -m "feat: header com pixel TikTok (identify com sck, load por pixel, ttclid/_ttp, IC no clique)"`

---

## Task 8: Cobertura por plataforma e aba **Plataformas** (dashboard)

**Files:**
- Modify: `src/lib/tracking/cobertura-meta.ts`, `src/lib/tracking/cobertura-meta-db.ts`, `src/app/admin/tracking/funil-card.tsx`, `src/app/admin/tracking/page.tsx`
- Test: `tests/cobertura-meta.test.ts`

**Interfaces:**
- Produces: `PLATAFORMAS_EVENTOS = { meta: { campos: CAMPOS_META, eventos: ['Purchase','InitiateCheckout'], chaveUser: 'user_data' }, tiktok: { campos: CAMPOS_TIKTOK, eventos: ['CompletePayment','InitiateCheckout'], chaveUser: 'user' } }`; `coberturaUserData(rows, plataforma)`; `getCobertura(funnelIds, plataforma)`; tipo `CoberturaPlataforma` com `compra` e `ic` (nomes neutros, já que o evento de compra se chama diferente em cada uma).

- [ ] **Step 1: Testes** — reescrever `tests/cobertura-meta.test.ts` para a assinatura nova: os testes de hoje passam `"meta"`; acrescentar um com `"tiktok"`: linhas `{ event_name: "CompletePayment", payload: JSON.stringify({ event: "CompletePayment", user: { email: "h", ttclid: "x", external_id: "h" } }) }` → `compra.campos.email === 100`, `ttclid 100`, `ttp 0`; e um IC TikTok com `user` só de `ttp`.

- [ ] **Step 2: Implementar** — no puro: `CAMPOS_TIKTOK = ["email","phone","external_id","ttclid","ttp","ip","user_agent"] as const`; `userDataDe(payload, chaveUser)`; `coberturaUserData(rows, plataforma)` devolve `{ compra: CoberturaEvento, ic: CoberturaEvento }` mapeando `eventos[0]` → `compra`, `eventos[1]` → `ic`; `juntarContagens` igual, pela mesma tabela. `CoberturaEvento.campos` vira `Record<string, number>` (as chaves vêm de `PLATAFORMAS_EVENTOS[p].campos`). No `-db.ts`: `getCobertura(funnelIds, plataforma)` com `AND plataforma = $N` nas três queries e os nomes de evento da plataforma. Manter `getCoberturaMeta` como `getCobertura(ids, "meta")` para o chamador atual.

`page.tsx`: calcula `{ meta, tiktok }` por domínio (dois `getCobertura`, cada um com seu catch) e passa `cobertura={{ meta, tiktok }}`.

`funil-card.tsx`: aba **Meta** vira **Plataformas** (`id: "plataformas"`); `AbaPlataformas({ cobertura })` renderiza dois blocos (título "Meta — CAPI" e "TikTok — Events API"), cada um com a tabela de hoje (`Compra` / `IC`), usando `PLATAFORMAS_EVENTOS[p].campos` e um `ROTULO_CAMPO` estendido (`email` "E-mail", `phone` "Telefone", `ttclid` "Clique (ttclid)", `ttp` "Cookie _ttp", `ip` "IP", `user_agent` "Navegador"). Bloco TikTok sem pixel cadastrado no domínio mostra "Sem pixel TikTok neste domínio." (a página passa `temTikTok`).

- [ ] **Step 3: Verificar** — `npm run check && npx next build`.

- [ ] **Step 4: Commit** — `git commit -m "feat: aba Plataformas — cobertura de user_data por plataforma (Meta e TikTok)"`

---

## Task 9: Runbook do dashboard

**Files:**
- Modify: `SETUP.md`

Fase 9 — "TikTok Ads — eventos (pixel + Events API)". Itens: (1) SQL pré-deploy está no `HANDOFF.md` do tracking (listar os nomes dos comandos, não repetir), inclusive o `GRANT` novo do `dashboard_rw`; (2) deploy tracking → dashboard; (3) gerar o token no Events Manager (caminho exato) e cadastrar na aba **TikTok** do card do domínio; (4) recolar o header em todas as páginas do domínio; (5) *Fontes de tráfego*: fonte `TikTok` com `utm_source = TT`; (6) modelo de URL nos anúncios (o texto exato da spec, com as macros `__CAMPAIGN_NAME__|__CAMPAIGN_ID__` etc.); (7) conferir: clique de checkout → aba **Plataformas** do card mostra IC TikTok aceito; *Test Events* só por minutos; (8) `send_to_tiktok` nasce igual ao `send_to_meta` — conferir upsells; (9) gasto e campanhas são o Projeto 2.

Commit: `git commit -m "docs: fase do TikTok no SETUP (token, aba TikTok, header, fonte TT, modelo de URL)"`.

---

## Ordem e dependências

Tracking 1 → 2 → 3 → 4 → 5 em série. Dashboard 6 → 7 → 8 → 9 em série (7 depende dos pixels da 6; 8 do `plataforma` que a 3 definiu). Deploy: SQL → tracking → dashboard → cadastrar pixel → recolar header.
