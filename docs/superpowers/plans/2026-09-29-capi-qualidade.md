# Qualidade de correspondência na Meta — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mandar para a Meta tudo o que já sabemos sobre quem compra — Purchase com os doze campos, IC também pela CAPI, `external_id` no pixel — e mostrar no dashboard o que está chegando.

**Architecture:** No tracking, `capi.js` ganha um construtor de IC, o fallback de `fbc` pelo `fbclid`, geo/IP/`external_id` da venda, e um remetente genérico com `test_event_code`; `/collect` dispara o IC depois de responder. No dashboard, o header resolve o `sck` antes do `fbq('init')` e o passa como `external_id`; o card do domínio ganha uma aba **Meta** lida do `event_log`.

**Tech Stack:** tracking — Node/Express, CommonJS, `pg`, `node --test`. dashboard — Next.js, Prisma, `node:test` com `tsx`.

## Global Constraints

- **Sistema EM PRODUÇÃO.** O `/collect` roda a cada clique de checkout de 10 funis; `vendas.js` processa vendas reais. Nenhuma mudança pode atrasar a resposta do `/collect` nem alterar quais vendas vão para a Meta.
- Nenhuma dependência npm nova, nos dois repositórios.
- Tracking: CommonJS, `npm test` (`node --test`), comentários **sem acento**. `||` ≠ `??` de propósito — não "limpar". Sem rede e sem banco nos testes (pool falso, `fetch` falso).
- Dashboard: `npm run check` (lint + typecheck + `tests/*.test.ts`), mensagens em português acentuado, leitura do tracking só por `query` de `src/lib/tracking/db.ts`. `diag-funis.ts` untracked na raiz — não commitar.
- **`event_id` do Purchase continua `'purchase_' + transaction_id`.** O do IC é o `sck` cru — tem que ser idêntico ao `eventID` que o header já manda no `fbq('track','InitiateCheckout')`.
- Hash sempre SHA-256 de valor normalizado (`hash()` já existente); nunca mandar `fbclid` cru como `fbc`.
- Nenhum banco alcançável da máquina de desenvolvimento.
- Baselines: tracking **77 passando, 0 falhas**; dashboard **490 / 469 passando / 21 skips / 0 falhas**.

---

## Contexto verificado no código

- `capi.js`: `buildPurchaseEvent({ funnel, sale, store })` lê `ct/st/country/external_id/fbc/fbp/ip/ua` só do `store`; `sendPurchase` monta `url`, `body = { data:[event], access_token }`, `fetch` com timeout 8s, devolve `{ httpStatus, response, payload }`. Exporta `{ sendPurchase, buildPurchaseEvent, hash }`. `clean()` remove `undefined/null/''`.
- `geo.js`: `normPais` só entende 2 letras, `brasil`, `brazil`. Exporta `normCidade, normEstado, normPais, normTelefone`.
- `vendas.js:74-82` carrega `store` e `click` (`SELECT * FROM clicks WHERE sck=$1 ORDER BY created_at DESC LIMIT 1`); `:159-167` monta `sale` só com `transaction_id, value, product_code, product_name, customer_email, customer_phone, customer_name`; `:171` chama `sendPurchase({ funnel: f, sale, store })`; `:174` grava `event_log (event_name, event_id, source, src, funnel_id, http_status, payload)`.
- `venda` (dos normalizadores) tem `sck, email, phone, nome, city, state, country, ip`. PayT: `ip` sim, geo não. Digistore24: geo sim, `ip` não.
- `server.js /collect` (linhas 140-197): resolve `funnel` por host, grava `store` e `clicks`, `res.json({ ok: true })`. `clicks` tem `fbclid`, `fbp`, `fbc`, `ip`, `user_agent`, `landing_url`, `created_at`.
- `server.js` já importa `sendPurchase` de `./capi` (linha 14) e não usa em lugar nenhum além de `vendas.js` — pode virar o import do IC.
- **Ninguém grava `InitiateCheckout` em `event_log` hoje.** O dashboard (`queries.ts:459-465`) já conta checkouts diários com `count(DISTINCT event_id) FROM event_log WHERE event_name = 'InitiateCheckout'` — série que está sempre zero. Com o `event_id = sck` do IC server-side, ela passa a valer (uma linha por pixel, `DISTINCT` resolve).
- `README.md` tem tabela `| Nome | Obrigatória | Descrição |` de variáveis.
- Dashboard `header.ts`: template em `String.raw`; `fbq('init', '{{PIXEL_ID}}');` na linha 34; `var sck = getCookie('index') || localStorage.getItem('index');` na 58 seguida de `if (!sck || sck === '') { sck = uuid(); }`, `setCookie('index', sck, TTL);`, `try { localStorage.setItem('index', sck); } catch (e) {}`. `TEMPLATE_OFICIAL_2_PIXELS` deriva por `.replace("fbq('init', '{{PIXEL_ID}}');\n", "fbq('init', '{{PIXEL_ID}}');\nfbq('init', '{{PIXEL_ID_2}}');\n")`. `validarHeader` conta `/fbq\('init', '\d+'\);/g`. `ANCORA_PIXEL_FIM = "fbq('track', 'PageView');\n</script>\n<script>"`. `tests/header.test.ts` compara `TEMPLATE_OFICIAL_*` byte a byte com `tests/fixtures/header/{1pixel,2pixel}.html` e espera 2 blocos `<script>` sem Google e 3 com.
- Dashboard `funil-card.tsx`: abas `"header" | "produtos" | "editar"`; `page.tsx:205` passa props ao card; `FunilTrackingDetalhe.id` é o `funnels.id` do tracking.
- `event_log.payload` é gravado com `JSON.stringify(r.payload)`; tipo da coluna desconhecido (text ou jsonb) — o leitor trata os dois.

---

## Estrutura de arquivos

| repo | arquivo | responsabilidade |
|---|---|---|
| tracking | `geo.js` | `normPais` com os países do tráfego |
| tracking | `capi.js` | `fbcDe`, `userDataBase`, `buildPurchaseEvent` (+click/sale), `buildInitiateCheckoutEvent`, `sendEvent`, `sendPurchase`, `sendInitiateCheckout` |
| tracking | `ic.js` | `enviarIC(pool, { funnels, click })`: envia para cada pixel e grava `event_log`. Testável com pool/fetch falsos |
| tracking | `vendas.js` | passa `click` e os campos da venda ao Purchase |
| tracking | `server.js` | `/collect` dispara `enviarIC` depois de responder; kill switch |
| tracking | `test/capi.test.js`, `test/ic.test.js`, `test/vendas.test.js` | testes |
| tracking | `README.md`, `HANDOFF.md` | variáveis e verificação |
| dashboard | `src/lib/tracking/header.ts`, `tests/fixtures/header/*.html`, `tests/header.test.ts` | `sck` antes do `init`, `external_id` |
| dashboard | `src/lib/tracking/cobertura-meta.ts`, `tests/cobertura-meta.test.ts` | leitura do `event_log` + função pura |
| dashboard | `src/app/admin/tracking/{page.tsx,funil-card.tsx}` | aba **Meta** |
| dashboard | `SETUP.md` | fase do operador |

---

## Task 1: `normPais` entende os países do tráfego (tracking)

**Files:**
- Modify: `geo.js`
- Test: `test/capi.test.js` (acrescentar)

- [ ] **Step 1: Testes que falham**

Acrescentar em `test/capi.test.js`, depois dos testes de `normEstado`:

```js
test('pais: ISO-2 minusculo a partir de sigla, nome ou ISO-3', () => {
  assert.strictEqual(normPais('BR'), 'br');
  assert.strictEqual(normPais('Brasil'), 'br');
  assert.strictEqual(normPais('US'), 'us');
  assert.strictEqual(normPais('USA'), 'us');
  assert.strictEqual(normPais('United States'), 'us');
  assert.strictEqual(normPais('Estados Unidos'), 'us');
  assert.strictEqual(normPais('United Kingdom'), 'gb');
  assert.strictEqual(normPais('UK'), 'gb');
  assert.strictEqual(normPais('Canada'), 'ca');
  assert.strictEqual(normPais('Portugal'), 'pt');
  assert.strictEqual(normPais('Australia'), 'au');
});

test('pais desconhecido fica ausente, nao inventado', () => {
  assert.strictEqual(normPais('Atlantida'), undefined);
  assert.strictEqual(normPais(''), undefined);
  assert.strictEqual(normPais(null), undefined);
});
```

- [ ] **Step 2: Ver falhar** — `npm test`.

- [ ] **Step 3: Implementar**

Em `geo.js`, trocar `normPais` por:

```js
// ISO-3166 alpha-2 minusculo. Aceita sigla de 2, ISO-3 e o nome por extenso nos
// idiomas em que as plataformas mandam (PayT: pt; Digistore24: en). Desconhecido
// fica ausente — a Meta diz que campo errado e pior que campo faltando.
const PAIS = {
  br:'br', bra:'br', brasil:'br', brazil:'br',
  us:'us', usa:'us', unitedstates:'us', unitedstatesofamerica:'us', estadosunidos:'us', eua:'us',
  ca:'ca', can:'ca', canada:'ca',
  gb:'gb', gbr:'gb', uk:'gb', unitedkingdom:'gb', reinounido:'gb', greatbritain:'gb',
  au:'au', aus:'au', australia:'au',
  pt:'pt', prt:'pt', portugal:'pt',
  es:'es', esp:'es', spain:'es', espanha:'es', espana:'es',
  mx:'mx', mex:'mx', mexico:'mx',
  de:'de', deu:'de', germany:'de', alemanha:'de', deutschland:'de',
  fr:'fr', fra:'fr', france:'fr', franca:'fr',
  it:'it', ita:'it', italy:'it', italia:'it',
  ie:'ie', irl:'ie', ireland:'ie', irlanda:'ie',
  nz:'nz', nzl:'nz', newzealand:'nz', novazelandia:'nz',
  ar:'ar', arg:'ar', argentina:'ar',
  cl:'cl', chl:'cl', chile:'cl',
  co:'co', col:'co', colombia:'co',
};

function normPais(v) {
  if (!v) return undefined;
  const k = semAcento(v).toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return undefined;
  if (PAIS[k]) return PAIS[k];
  // sigla de 2 letras que nao esta na tabela: e ISO-2 valido na pratica
  // (a Meta so exige o formato), entao passa.
  if (k.length === 2) return k;
  return undefined;
}
```

- [ ] **Step 4: Ver passar** — `npm test` (77 + 2 = 79).

- [ ] **Step 5: Commit** — `git commit -m "feat: normPais entende os paises do trafego (US, GB, CA, ...)"`

---

## Task 2: `capi.js` — Purchase completo, IC, remetente genérico (tracking)

**Files:**
- Modify: `capi.js`
- Test: `test/capi.test.js` (acrescentar)

**Interfaces:**
- Produces: `fbcDe(fbc, fbclid, criadoEm)`, `buildPurchaseEvent({ funnel, sale, store, click })` (o `click` é novo e opcional), `buildInitiateCheckoutEvent({ funnel, click })`, `sendEvent({ funnel, event })`, `sendPurchase` (mesma assinatura + `click`), `sendInitiateCheckout({ funnel, click })`. `sale` passa a poder trazer `sck, city, state, country, ip`.

- [ ] **Step 1: Testes que falham**

Acrescentar em `test/capi.test.js` (o topo já importa `hash, buildPurchaseEvent`; acrescente `fbcDe, buildInitiateCheckoutEvent` ao `require('../capi')`):

```js
const funnelX = { pixel_id: '123', capi_token: 'tok', currency: 'BRL' };

test('fbc: usa o cookie quando existe; senao monta do fbclid com o timestamp do clique', () => {
  assert.strictEqual(fbcDe('fb.1.1700000000000.ABC', 'XYZ', new Date(0)), 'fb.1.1700000000000.ABC');
  assert.strictEqual(fbcDe(null, 'XYZ', new Date(1700000000000)), 'fb.1.1700000000000.XYZ');
  assert.strictEqual(fbcDe('', 'XYZ', '2023-11-14T22:13:20.000Z'), 'fb.1.1700000000000.XYZ');
  assert.strictEqual(fbcDe(null, null, new Date()), undefined);
  assert.strictEqual(fbcDe(null, 'XYZ', null), undefined);
});

test('Purchase: geo cai para a venda quando o store nao tem, ja normalizado', () => {
  const ev = buildPurchaseEvent({
    funnel: funnelX,
    sale: { transaction_id: 'T1', value: 97, city: 'Sao Paulo', state: 'SP', country: 'Brasil' },
    store: {},
  });
  assert.strictEqual(ev.user_data.ct, hash('saopaulo'));
  assert.strictEqual(ev.user_data.st, hash('sp'));
  assert.strictEqual(ev.user_data.country, hash('br'));
});

test('Purchase: store vence a venda no geo, e US chega como us', () => {
  const ev = buildPurchaseEvent({
    funnel: funnelX,
    sale: { transaction_id: 'T1', value: 97, country: 'Brasil' },
    store: { country: 'United States' },
  });
  assert.strictEqual(ev.user_data.country, hash('us'));
});

test('Purchase: external_id e o hash do sck; ausente sem sck', () => {
  const com = buildPurchaseEvent({ funnel: funnelX, sale: { transaction_id: 'T1', value: 1, sck: 'idx_abc' }, store: null });
  assert.strictEqual(com.user_data.external_id, hash('idx_abc'));
  const sem = buildPurchaseEvent({ funnel: funnelX, sale: { transaction_id: 'T1', value: 1 }, store: null });
  assert.strictEqual(sem.user_data.external_id, undefined);
});

test('Purchase: fbc monta do fbclid do clique quando o store nao tem cookie', () => {
  const ev = buildPurchaseEvent({
    funnel: funnelX,
    sale: { transaction_id: 'T1', value: 1 },
    store: { fbp: 'fb.1.1.2' },
    click: { fbclid: 'CLK', created_at: new Date(1700000000000) },
  });
  assert.strictEqual(ev.user_data.fbc, 'fb.1.1700000000000.CLK');
  assert.strictEqual(ev.user_data.fbp, 'fb.1.1.2');
});

test('Purchase: ip cai para o da venda (PayT manda) quando o store nao tem', () => {
  const ev = buildPurchaseEvent({ funnel: funnelX, sale: { transaction_id: 'T1', value: 1, ip: '1.2.3.4' }, store: null });
  assert.strictEqual(ev.user_data.client_ip_address, '1.2.3.4');
});

test('Purchase sem os dados novos e identico ao de antes (nao-regressao)', () => {
  const store = { fbp: 'fb.1.1.2', fbc: 'fb.1.1.X', ip_override: '9.9.9.9', user_agent: 'UA', page_location: 'https://x/y' };
  const sale = { transaction_id: 'T1', value: 97, customer_email: 'a@b.com', customer_phone: '11999998888', customer_name: 'Ana Souza', product_code: 'P1', product_name: 'Prod' };
  const ev = buildPurchaseEvent({ funnel: funnelX, sale, store });
  assert.deepStrictEqual(Object.keys(ev.user_data).sort(),
    ['client_ip_address', 'client_user_agent', 'em', 'fbc', 'fbp', 'fn', 'ln', 'ph'].sort());
  assert.strictEqual(ev.event_id, 'purchase_T1');
  assert.strictEqual(ev.event_source_url, 'https://x/y');
  assert.strictEqual(ev.custom_data.order_id, 'T1');
});

test('IC: event_id e o sck cru, user_data so com o que o clique tem, sem custom_data', () => {
  const ev = buildInitiateCheckoutEvent({
    funnel: funnelX,
    click: { sck: 'idx_abc', fbp: 'fb.1.1.2', fbc: null, fbclid: 'CLK', ip: '1.2.3.4', user_agent: 'UA',
             landing_url: 'https://x/vsl', created_at: new Date(1700000000000) },
  });
  assert.strictEqual(ev.event_name, 'InitiateCheckout');
  assert.strictEqual(ev.event_id, 'idx_abc');
  assert.strictEqual(ev.action_source, 'website');
  assert.strictEqual(ev.event_source_url, 'https://x/vsl');
  assert.strictEqual(ev.custom_data, undefined);
  assert.deepStrictEqual(ev.user_data, {
    client_ip_address: '1.2.3.4', client_user_agent: 'UA',
    fbp: 'fb.1.1.2', fbc: 'fb.1.1700000000000.CLK', external_id: hash('idx_abc'),
  });
});

test('IC sem sck nao e construido', () => {
  assert.strictEqual(buildInitiateCheckoutEvent({ funnel: funnelX, click: { fbp: 'x' } }), null);
});
```

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: Implementar em `capi.js`**

Substituir do comentário de `buildPurchaseEvent` até o fim do arquivo por:

```js
// fbc: o cookie _fbc quando existe; senao o formato que a Meta documenta para
// montar a partir do fbclid da URL: fb.1.<ms do clique>.<fbclid>. fbclid cru
// nunca sai — a Meta nao aceita.
function fbcDe(fbc, fbclid, criadoEm) {
  if (fbc) return fbc;
  if (!fbclid || !criadoEm) return undefined;
  const ms = criadoEm instanceof Date ? criadoEm.getTime() : new Date(criadoEm).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return `fb.1.${ms}.${fbclid}`;
}

// A parte do user_data que vem do navegador, comum a Purchase e IC.
// `store` e a linha de store (checkout); `click` e a linha de clicks.
// O sck e o id proprio do visitante: vira external_id (hash), estavel do
// primeiro clique ate a compra — e o que liga os eventos da mesma pessoa.
function userDataBase({ store, click, sck, ipFallback }) {
  return {
    client_user_agent: store?.user_agent || click?.user_agent || undefined,
    client_ip_address: store?.ip_override || click?.ip || ipFallback || undefined,
    fbc: fbcDe(store?.fbc || click?.fbc, click?.fbclid, click?.created_at),
    fbp: store?.fbp || click?.fbp || undefined,
    external_id: sck ? hash(sck) : (store?.external_id ? hash(store.external_id) : undefined),
  };
}

// monta o evento Purchase (puro, sem rede — exportado para teste)
function buildPurchaseEvent({ funnel, sale, store, click }) {
  const { fn, ln } = splitName(sale.customer_name);

  // geo: o store nunca teve (o header nao manda), entao na pratica vem da
  // venda — a Digistore24 manda cidade/estado/pais no IPN. PayT nao manda.
  const user_data = clean({
    em: hash(sale.customer_email),
    ph: hash(normTelefone(sale.customer_phone)),
    fn, ln,
    ct: hash(normCidade(store?.city || sale.city)),
    st: hash(normEstado(store?.state || sale.state)),
    country: hash(normPais(store?.country || sale.country)),
    ...userDataBase({ store, click, sck: sale.sck || store?.sck, ipFallback: sale.ip }),
  });

  const custom_data = clean({
    currency: funnel.currency || 'BRL',
    value: Number(sale.value) || 0,          // comissão, conforme decidido
    content_ids: sale.product_code ? [sale.product_code] : undefined,
    content_name: sale.product_name || undefined,
    order_id: sale.transaction_id,
  });

  return clean({
    event_name: 'Purchase',
    event_time: sale.event_time || Math.floor(Date.now() / 1000),
    // event_id derivado da TRANSACAO, nao do sck. O sck identifica a sessao:
    // uma compra + um upsell na mesma sessao geravam o mesmo event_id e a Meta
    // descartava o segundo. A dedupe da Meta so opera entre eventos de mesmo
    // event_name, entao compartilhar o id com o InitiateCheckout nao trazia
    // beneficio nenhum. Reenvio do mesmo webhook continua deduplicado.
    event_id: 'purchase_' + sale.transaction_id,
    action_source: 'website',
    event_source_url: store?.page_location || click?.landing_url || undefined,
    user_data,
    custom_data,
  });
}

// monta o InitiateCheckout server-side a partir da linha de clicks. event_id =
// sck cru: e o eventID que o header ja manda no fbq('track','InitiateCheckout'),
// e e por ele que a Meta deduplica pixel x servidor (48h). Sem custom_data.
function buildInitiateCheckoutEvent({ funnel, click }) {
  if (!click || !click.sck) return null;
  return clean({
    event_name: 'InitiateCheckout',
    event_time: Math.floor((click.created_at ? new Date(click.created_at).getTime() : Date.now()) / 1000),
    event_id: click.sck,
    action_source: 'website',
    event_source_url: click.landing_url || undefined,
    user_data: clean(userDataBase({ store: null, click, sck: click.sck })),
  });
}

// envia um evento ja montado para o pixel do funil
async function sendEvent({ funnel, event }) {
  const url = `${GRAPH}/${funnel.pixel_id}/events`;
  // token no corpo, nao na query: a URL aparece em qualquer log de erro
  // que a imprima e em traces de biblioteca HTTP.
  const body = { data: [event], access_token: funnel.capi_token };
  // Com META_TEST_EVENT_CODE definido os eventos aparecem em tempo real na aba
  // "Testar eventos" do Gerenciador de Eventos e NAO contam para otimizacao.
  // So para conferir a integracao; em producao fica vazio.
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // undici não tem timeout de request por padrão (só headersTimeout ~5min).
    // O loop de pixels em server.js é sequencial, então o pior caso soma.
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, response: json, payload: event };
}

async function sendPurchase({ funnel, sale, store, click }) {
  return sendEvent({ funnel, event: buildPurchaseEvent({ funnel, sale, store, click }) });
}

async function sendInitiateCheckout({ funnel, click }) {
  const event = buildInitiateCheckoutEvent({ funnel, click });
  if (!event) return { httpStatus: 0, response: { skipped: 'sem_sck' }, payload: null };
  return sendEvent({ funnel, event });
}

// remove chaves undefined/null (a Meta rejeita campos vazios)
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

module.exports = {
  sendPurchase, sendInitiateCheckout, sendEvent,
  buildPurchaseEvent, buildInitiateCheckoutEvent, fbcDe, hash,
};
```

Atualizar o comentário do topo do arquivo: "Purchase: 12 user_data" continua verdade; acrescentar uma linha "InitiateCheckout: 5 user_data do clique, event_id = sck (dedupe com o pixel)".

- [ ] **Step 4: Ver passar** — `npm test` (79 + 9 = 88). Os testes antigos de `capi.test.js` e `vendas.test.js` continuam verdes: `click` é opcional e `sale` sem os campos novos produz o mesmo evento.

- [ ] **Step 5: Commit** — `git commit -m "feat: Purchase com geo, external_id, fbc do fbclid e ip da venda; IC server-side; test_event_code"`

---

## Task 3: `vendas.js` passa o que a CAPI precisa (tracking)

**Files:**
- Modify: `vendas.js`
- Test: `test/vendas.test.js` (acrescentar)

- [ ] **Step 1: Teste que falha**

Acrescentar em `test/vendas.test.js` (reutilizar `fakePoolComFunil`; ele já responde `clicks` com `rows: []` — acrescente um parâmetro `clickRow` opcional a essa fixture, devolvendo `[clickRow]` quando dado):

```js
test('o Purchase leva sck, geo e ip da venda e o clique com fbclid', async (t) => {
  const fetchOriginal = global.fetch;
  let corpo = null;
  global.fetch = async (_url, opts) => { corpo = JSON.parse(opts.body); return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePoolComFunil({
    storeRow: { src: 'fb', fbp: 'fb.1.1.2' },
    clickRow: { sck: 'idx_abc', fbclid: 'CLK', created_at: new Date(1700000000000), ip: '5.5.5.5', user_agent: 'UA' },
  });
  const venda = { txId: 'T5', sck: 'idx_abc', src: 'fb', paid: true, value: 10, total: 10, origem: 'digistore24',
    email: 'a@b.com', city: 'Austin', state: 'TX', country: 'United States', ip: null };
  await processarVenda(pool, venda);

  const ud = corpo.data[0].user_data;
  assert.ok(ud.external_id, 'external_id (hash do sck) deveria ir');
  assert.strictEqual(ud.fbc, 'fb.1.1700000000000.CLK');
  assert.ok(ud.country, 'country deveria ir (United States -> us)');
  assert.ok(ud.ct && ud.st, 'cidade e estado deveriam ir');
  assert.strictEqual(ud.client_ip_address, '5.5.5.5');
});
```

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: Implementar**

Em `vendas.js`, o objeto `sale` (linha ~159) ganha os campos e a chamada passa o `click`:

```js
    const sale = {
      transaction_id: txId,
      value,
      product_code: venda.productCode,
      product_name: venda.productName,
      customer_email: venda.email,
      customer_phone: venda.phone,
      customer_name: venda.nome,
      // Para o user_data da CAPI: sck vira external_id; geo e ip sao fallback
      // quando o store nao tem (o header nunca mandou geo; PayT manda ip,
      // Digistore24 manda geo).
      sck,
      city: venda.city, state: venda.state, country: venda.country,
      ip: venda.ip,
    };
```

e `sendPurchase({ funnel: f, sale, store })` vira `sendPurchase({ funnel: f, sale, store, click })`.

Nada mais em `vendas.js`.

- [ ] **Step 4: Ver passar** — `npm test` (88 + 1 = 89).

- [ ] **Step 5: Commit** — `git commit -m "feat: vendas.js entrega sck, geo, ip e o clique ao Purchase da CAPI"`

---

## Task 4: IC pela CAPI a partir do `/collect` (tracking)

**Files:**
- Create: `ic.js`
- Modify: `server.js`
- Test: `test/ic.test.js`

**Interfaces:**
- Produces: `enviarIC(pool, { dominio, click })` — busca os funis ativos do domínio, manda um IC por pixel, grava `event_log`, devolve `{ enviados, aceitos }`. Nunca lança: erro vira `console.error('CAPI_IC_FALHOU', ...)`.

- [ ] **Step 1: Testes que falham**

`test/ic.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { enviarIC } = require('../ic');

const click = { sck: 'idx_abc', fbp: 'fb.1.1.2', fbc: null, fbclid: 'CLK', ip: '1.2.3.4',
  user_agent: 'UA', landing_url: 'https://x/vsl', created_at: new Date(1700000000000) };

function fakePool(funnels) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('FROM funnels WHERE active AND domain')) return { rows: funnels };
      return { rows: [] };
    },
  };
}

test('manda um IC por pixel do dominio e grava event_log com event_id = sck', async (t) => {
  const fetchOriginal = global.fetch;
  const corpos = [];
  global.fetch = async (url, opts) => { corpos.push({ url, body: JSON.parse(opts.body) }); return { status: 200, json: async () => ({ events_received: 1 }) }; };
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePool([
    { id: 1, pixel_id: '111', capi_token: 't1', domain: 'www.x.com', active: true },
    { id: 2, pixel_id: '222', capi_token: 't2', domain: 'www.x.com', active: true },
  ]);
  const r = await enviarIC(pool, { dominio: 'www.x.com', click });

  assert.deepStrictEqual(r, { enviados: 2, aceitos: 2 });
  assert.ok(corpos[0].url.includes('/111/events') && corpos[1].url.includes('/222/events'));
  assert.strictEqual(corpos[0].body.data[0].event_name, 'InitiateCheckout');
  assert.strictEqual(corpos[0].body.data[0].event_id, 'idx_abc');
  const logs = pool.calls.filter(c => c.text.includes('INSERT INTO event_log'));
  assert.strictEqual(logs.length, 2);
  assert.strictEqual(logs[0].params[0], 'idx_abc');
  assert.strictEqual(logs[0].params[2], 1);
});

test('Meta fora do ar nao lanca: conta como nao aceito e loga', async (t) => {
  const fetchOriginal = global.fetch;
  global.fetch = async () => { throw new Error('ECONNRESET'); };
  const erroOriginal = console.error; const erros = [];
  console.error = (...a) => erros.push(a.join(' '));
  t.after(() => { global.fetch = fetchOriginal; console.error = erroOriginal; });

  const pool = fakePool([{ id: 1, pixel_id: '111', capi_token: 't1', domain: 'www.x.com', active: true }]);
  const r = await enviarIC(pool, { dominio: 'www.x.com', click });
  assert.deepStrictEqual(r, { enviados: 1, aceitos: 0 });
  assert.ok(erros.some(e => e.includes('CAPI_IC_FALHOU')));
});

test('sem funil ativo no dominio, nao manda nada', async () => {
  const pool = fakePool([]);
  const r = await enviarIC(pool, { dominio: 'www.x.com', click });
  assert.deepStrictEqual(r, { enviados: 0, aceitos: 0 });
});

test('sem sck nao manda nada', async () => {
  const pool = fakePool([{ id: 1, pixel_id: '111', capi_token: 't1' }]);
  const r = await enviarIC(pool, { dominio: 'www.x.com', click: { ...click, sck: null } });
  assert.deepStrictEqual(r, { enviados: 0, aceitos: 0 });
});

test('CAPI_IC_DESLIGADO=1 desliga sem erro', async (t) => {
  process.env.CAPI_IC_DESLIGADO = '1';
  t.after(() => { delete process.env.CAPI_IC_DESLIGADO; });
  const pool = fakePool([{ id: 1, pixel_id: '111', capi_token: 't1' }]);
  const r = await enviarIC(pool, { dominio: 'www.x.com', click });
  assert.deepStrictEqual(r, { enviados: 0, aceitos: 0, desligado: true });
  assert.strictEqual(pool.calls.length, 0);
});
```

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: Criar `ic.js`**

```js
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
        `INSERT INTO event_log (event_name, event_id, source, src, funnel_id, http_status, payload)
         VALUES ('InitiateCheckout',$1,'server',$2,$3,$4,$5)`,
        [click.sck, click.src || null, f.id, status, JSON.stringify(payload)]);
    } catch (e) {
      console.error('CAPI_IC_FALHOU', JSON.stringify({ etapa: 'event_log', pixel: f.pixel_id, erro: String(e).slice(0, 200) }));
    }
  }
  return { enviados: funnels.length, aceitos };
}

module.exports = { enviarIC };
```

- [ ] **Step 4: Ligar no `/collect`**

Em `server.js`:
- no topo, trocar `const { sendPurchase } = require('./capi');` por `const { enviarIC } = require('./ic');` (o `sendPurchase` não é usado em `server.js`).
- no `/collect`, o `INSERT INTO clicks` passa a devolver a linha: acrescentar ` RETURNING *` ao final do SQL e capturar `const ins = await pool.query(...)`; depois de `res.json({ ok: true });` acrescentar:

```js
    // IC pela CAPI depois de responder: nunca no caminho do clique. O clique
    // recem-gravado ja tem tudo que o evento precisa (fbp/fbc/fbclid/ip/ua).
    const clickRow = ins.rows && ins.rows[0];
    if (funnel && clickRow) {
      setImmediate(() => {
        enviarIC(pool, { dominio: funnel.domain, click: clickRow })
          .catch((e) => console.error('CAPI_IC_FALHOU', JSON.stringify({ etapa: 'setImmediate', erro: String(e).slice(0, 200) })));
      });
    }
```

Atualizar o cabeçalho de rotas do arquivo: `POST /collect ... (store + clicks + IC via CAPI)`.

- [ ] **Step 5: Ver passar** — `node --check server.js && npm test` (89 + 5 = 94).

- [ ] **Step 6: Commit** — `git commit -m "feat: InitiateCheckout pela CAPI a partir do /collect, sem bloquear a resposta"`

---

## Task 5: Runbook do tracking

**Files:**
- Modify: `README.md`, `HANDOFF.md`

- [ ] **Step 1: README**

Na tabela de variáveis, duas linhas novas no formato existente:

- `META_TEST_EVENT_CODE` | não | Código da aba *Testar eventos* do Gerenciador de Eventos. Com ele definido, todo evento da CAPI sai com `test_event_code` e aparece lá em tempo real, **sem contar para otimização**. Só para conferir; em produção fica vazio.
- `CAPI_IC_DESLIGADO` | não | `1` desliga o InitiateCheckout pela CAPI (o do pixel continua). Kill switch; nasce ligado.

Na lista de rotas, `/collect` ganha "e dispara InitiateCheckout pela CAPI depois de responder". No índice de prefixos de log, `CAPI_IC_FALHOU`.

- [ ] **Step 2: HANDOFF**

Seção nova "Qualidade de correspondência (CAPI completa + IC server-side)", no estilo das outras, com:

1. **Antes do deploy:** anotar a nota EMQ do Purchase de cada pixel (Gerenciador de Eventos › pixel › Purchase › *Qualidade da correspondência*). Sem banco a mexer — não há `ALTER`.
2. **Deploy do tracking.** Efeito imediato: Purchase com mais campos; IC pela CAPI em todo clique de checkout.
3. **Conferir com a aba Testar eventos:** definir `META_TEST_EVENT_CODE` com o código da aba (ex.: `TEST12345`), redeploy, fazer um clique de checkout e uma venda de teste; ver o `InitiateCheckout` e o `Purchase` chegarem com os campos de `user_data` reconhecidos; **apagar a variável e redeployar** — com ela definida os eventos não otimizam nada.
4. **Recolar o header** (depois do deploy do dashboard, ver a fase no `SETUP.md` de lá): é o que põe o `external_id` no pixel. Sem recolar, o servidor já manda `external_id`, mas o navegador não.
5. **Depois de 7 dias:** comparar a nota EMQ com a do passo 1. O que mais mexe: `country` (Digistore24), `external_id` (todos), `fbc` montado do `fbclid`.
6. **Volume:** `event_log` ganha uma linha por pixel por clique de checkout. A retenção de 90 dias sugerida na Task 8 passa a valer a pena.
7. **Rollback:** `CAPI_IC_DESLIGADO=1` desliga o IC sem deploy; o Purchase novo não tem switch — os campos a mais são só dados que a Meta aceita ou ignora.

- [ ] **Step 3: Commit** — `git commit -m "docs: runbook da qualidade de correspondencia (variaveis, testar eventos, EMQ antes e depois)"`

---

## Task 6: Header com `external_id` no `fbq('init')` (dashboard)

**Files:**
- Modify: `src/lib/tracking/header.ts`, `tests/fixtures/header/1pixel.html`, `tests/fixtures/header/2pixel.html`, `tests/header.test.ts`

**Mudança deliberada do template para todos os funis.** Os fixtures são o espelho do template e mudam junto; o teste de fidelidade continua valendo a partir do novo.

- [ ] **Step 1: Testes que falham**

Em `tests/header.test.ts`:
- no teste "header de 1 pixel: COLLECT_URL, init e PageView", trocar a asserção do init por `assert.equal((html.match(/fbq\('init', '\d+', \{ external_id: sck \}\);/g) ?? []).length, 1);`
- no de 2 pixels, idem com `2`.
- acrescentar:

```ts
test("o sck existe antes do fbq('init') e vai como external_id no matching avançado", () => {
  const html = gerarHeader({ dominio: "prazeremcena.com", pixels: ["123456789012345"] });
  const iSck = html.indexOf("window.__sck = ");
  const iInit = html.indexOf("fbq('init', '123456789012345', { external_id: sck });");
  const iCapture = html.indexOf("var sck = window.__sck;");
  assert.ok(iSck > -1 && iInit > -1 && iCapture > -1);
  assert.ok(iSck < iInit && iInit < iCapture, "ordem: sck, init, capture");
  // a resolucao do sck e a mesma de sempre: cookie -> localStorage -> novo idx_
  assert.ok(html.includes("return 'idx_' + Date.now().toString(36)"));
  assert.ok(html.includes("getCookie('index') || localStorage.getItem('index')"));
});
```

- no teste "o JS gerado é sintaticamente válido (node --check)", `blocos.length` passa de `2` para `3`; no "com Google: os blocos <script> continuam sintaticamente válidos", de `3` para `4`.

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: Template**

Em `header.ts`, o `TEMPLATE_1_PIXEL` passa a começar assim (o comentário do topo e o bloco `!function(f,b,e,v,n,t,s)` não mudam; o que muda é: um bloco novo antes do pixel, o `init` com o objeto, e o capture lendo `window.__sck`):

```
<!-- TRACKING {{DOMAIN}} - pixel {{PIXEL_ID}} -->
<script>
(function () {
  function getCookie(n) {
    var m = document.cookie.match('(^|;)\\s*' + n + '\\s*=\\s*([^;]+)');
    return m ? m.pop() : null;
  }
  function uuid() { return 'idx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 11); }
  var sck = getCookie('index') || localStorage.getItem('index');
  if (!sck || sck === '') { sck = uuid(); }
  window.__sck = sck;
})();
var sck = window.__sck;
</script>
<script>
!function(f,b,e,v,n,t,s)
... (igual) ...
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '{{PIXEL_ID}}', { external_id: sck });
fbq('track', 'PageView');
</script>
<script>
(function () {
  var COLLECT_URL   = 'https://track.{{DOMAIN}}/collect';
  ...
  function uuid() { ... }   (mantém)
  var sck = window.__sck;
  setCookie('index', sck, TTL);
  try { localStorage.setItem('index', sck); } catch (e) {}
```

Ou seja, no bloco de captura as duas linhas

```
  var sck = getCookie('index') || localStorage.getItem('index');
  if (!sck || sck === '') { sck = uuid(); }
```

viram uma: `  var sck = window.__sck;`. `setCookie`/`localStorage.setItem` continuam ali (renovam o TTL). A função `getCookie` fica duplicada nos dois blocos de propósito — o primeiro bloco precisa dela antes de o segundo existir, e é o mesmo regex com as mesmas barras.

`TEMPLATE_OFICIAL_2_PIXELS`: a derivação passa a substituir `"fbq('init', '{{PIXEL_ID}}', { external_id: sck });\n"` por `"fbq('init', '{{PIXEL_ID}}', { external_id: sck });\nfbq('init', '{{PIXEL_ID_2}}', { external_id: sck });\n"`.

`validarHeader`: o regex dos inits vira `/fbq\('init', '\d+', \{ external_id: sck \}\);/g`. Acrescentar: `if (!html.includes("window.__sck = sck;") || !html.includes("var sck = window.__sck;")) throw new HeaderInvalidoError("o sck nao esta sendo resolvido antes do fbq('init').");`.

As âncoras do Google (`ANCORA_PIXEL_FIM`, `ANCORA_FBCLID`, etc.) continuam existindo uma vez cada — conferir com `assertUmaVez`, que já existe.

- [ ] **Step 4: Fixtures**

Regenerar `tests/fixtures/header/1pixel.html` e `2pixel.html` a partir dos templates novos: um script de uma linha com `tsx` que escreve `TEMPLATE_OFICIAL_1_PIXEL` e `TEMPLATE_OFICIAL_2_PIXELS` nos dois arquivos. Conferir no `git diff` dos fixtures que a **única** diferença é o bloco novo, o `init` e a linha do `sck` — nada mais.

- [ ] **Step 5: Ver passar** — `npm run check` (490 + 1 = 491).

- [ ] **Step 6: Commit** — `git commit -m "feat: header resolve o sck antes do pixel e o manda como external_id (matching avancado)"`

---

## Task 7: Aba **Meta** no card do domínio (dashboard)

**Files:**
- Create: `src/lib/tracking/cobertura-meta.ts`
- Modify: `src/app/admin/tracking/page.tsx`, `src/app/admin/tracking/funil-card.tsx`
- Test: `tests/cobertura-meta.test.ts`

**Interfaces:**
- Produces: `coberturaUserData(rows)` pura; `getCoberturaMeta(funnelIds)` que lê o tracking; tipo `CoberturaMeta`.

- [ ] **Step 1: Testes que falham**

`tests/cobertura-meta.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { coberturaUserData, CAMPOS_META } from "../src/lib/tracking/cobertura-meta";

const linha = (event_name: string, http_status: number, user_data: Record<string, string>) => ({
  event_name, http_status, payload: JSON.stringify({ event_name, user_data }),
});

test("conta eventos e aceitos por nome, e a cobertura de cada campo em %", () => {
  const rows = [
    linha("Purchase", 200, { em: "h", ph: "h", fbp: "x", external_id: "h" }),
    linha("Purchase", 200, { em: "h", fbp: "x", fbc: "y", external_id: "h", country: "h" }),
    linha("Purchase", 400, { em: "h" }),
    linha("InitiateCheckout", 200, { fbp: "x", external_id: "h", client_ip_address: "1" }),
  ];
  const c = coberturaUserData(rows);
  assert.equal(c.Purchase.enviados, 3);
  assert.equal(c.Purchase.aceitos, 2);
  assert.equal(c.Purchase.campos.em, 100);
  assert.equal(c.Purchase.campos.ph, 33);
  assert.equal(c.Purchase.campos.fbc, 33);
  assert.equal(c.Purchase.campos.country, 33);
  assert.equal(c.Purchase.campos.ct, 0);
  assert.equal(c.InitiateCheckout.enviados, 1);
  assert.equal(c.InitiateCheckout.campos.external_id, 100);
  assert.equal(c.InitiateCheckout.campos.em, 0);
});

test("payload já parseado (jsonb) e payload inválido não quebram", () => {
  const rows = [
    { event_name: "Purchase", http_status: 200, payload: { user_data: { em: "h" } } },
    { event_name: "Purchase", http_status: 200, payload: "isto nao e json" },
    { event_name: "Purchase", http_status: 200, payload: null },
  ];
  const c = coberturaUserData(rows);
  assert.equal(c.Purchase.enviados, 3);
  assert.equal(c.Purchase.campos.em, 33);
});

test("sem linhas devolve zeros, não NaN", () => {
  const c = coberturaUserData([]);
  assert.equal(c.Purchase.enviados, 0);
  for (const k of CAMPOS_META) assert.equal(c.Purchase.campos[k], 0);
});
```

- [ ] **Step 2: Ver falhar.**

- [ ] **Step 3: `src/lib/tracking/cobertura-meta.ts`**

```ts
import { query } from "@/lib/tracking/db";

/** Campos de user_data que a Meta pesa na qualidade de correspondência, na ordem da tela. */
export const CAMPOS_META = [
  "em", "ph", "fn", "ln", "external_id", "fbp", "fbc",
  "client_ip_address", "client_user_agent", "ct", "st", "country",
] as const;
export type CampoMeta = (typeof CAMPOS_META)[number];

export type CoberturaEvento = {
  enviados: number;
  aceitos: number;
  /** % de eventos enviados que levaram o campo (0–100, inteiro). */
  campos: Record<CampoMeta, number>;
};
export type CoberturaMeta = { Purchase: CoberturaEvento; InitiateCheckout: CoberturaEvento };

type Linha = { event_name: string; http_status: number | null; payload: unknown };

function userDataDe(payload: unknown): Record<string, unknown> | null {
  let p = payload;
  if (typeof p === "string") {
    try { p = JSON.parse(p); } catch { return null; }
  }
  if (!p || typeof p !== "object") return null;
  const ud = (p as { user_data?: unknown }).user_data;
  return ud && typeof ud === "object" ? (ud as Record<string, unknown>) : null;
}

function vazio(): CoberturaEvento {
  const campos = Object.fromEntries(CAMPOS_META.map((k) => [k, 0])) as Record<CampoMeta, number>;
  return { enviados: 0, aceitos: 0, campos };
}

/**
 * Pura. Lê o payload que o tracking gravou em `event_log` (os valores já vêm em hash) e diz,
 * por evento, quantos saíram, quantos a Meta aceitou (HTTP 200) e em que % de eventos cada
 * campo de user_data estava presente. É a leitura interna do que o Gerenciador de Eventos
 * mostra como qualidade de correspondência.
 */
export function coberturaUserData(rows: Linha[]): CoberturaMeta {
  const acc: Record<string, { enviados: number; aceitos: number; presentes: Record<CampoMeta, number> }> = {};
  for (const nome of ["Purchase", "InitiateCheckout"]) {
    acc[nome] = { enviados: 0, aceitos: 0, presentes: Object.fromEntries(CAMPOS_META.map((k) => [k, 0])) as Record<CampoMeta, number> };
  }
  for (const r of rows) {
    const a = acc[r.event_name];
    if (!a) continue;
    a.enviados++;
    if (r.http_status === 200) a.aceitos++;
    const ud = userDataDe(r.payload);
    if (!ud) continue;
    for (const k of CAMPOS_META) if (ud[k] !== undefined && ud[k] !== null && ud[k] !== "") a.presentes[k]++;
  }
  const saida = { Purchase: vazio(), InitiateCheckout: vazio() };
  for (const nome of ["Purchase", "InitiateCheckout"] as const) {
    const a = acc[nome];
    saida[nome].enviados = a.enviados;
    saida[nome].aceitos = a.aceitos;
    for (const k of CAMPOS_META) {
      saida[nome].campos[k] = a.enviados ? Math.round((a.presentes[k] / a.enviados) * 100) : 0;
    }
  }
  return saida;
}

/** Últimos 7 dias dos funis dados. Teto de linhas para a tela nunca ficar lenta. */
export async function getCoberturaMeta(funnelIds: number[]): Promise<CoberturaMeta> {
  if (!funnelIds.length) return coberturaUserData([]);
  const rows = await query<Linha>(
    `SELECT event_name, http_status, payload
       FROM event_log
      WHERE funnel_id = ANY($1::int[])
        AND event_name IN ('Purchase', 'InitiateCheckout')
        AND created_at >= now() - interval '7 days'
      ORDER BY created_at DESC
      LIMIT 5000`,
    [funnelIds],
  );
  return coberturaUserData(rows);
}
```

- [ ] **Step 4: Página e card**

`page.tsx`: dentro do bloco que já lê o tracking (o `try` que monta `funis`), para cada domínio calcular `cobertura` com `getCoberturaMeta(linhas.map((l) => l.id))` — em paralelo por domínio (`Promise.all` sobre os domínios), dentro do mesmo `try`, e com `catch` próprio por domínio devolvendo `null` (a aba mostra "sem dados" em vez de derrubar a página). Passar `cobertura={d.cobertura}` ao `FunilTrackingCard`.

`funil-card.tsx`: prop `cobertura: CoberturaMeta | null`; aba nova `"meta"` com rótulo **Meta**, depois de "Header". Componente `AbaMeta({ cobertura })`:
- se `null`: `<p>` "Sem leitura do event_log do tracking."
- senão, uma tabela com `Th`/`Td` de `@/components/ui`: colunas **Campo · Purchase · IC**; primeira linha "Eventos (7 dias)" com `aceitos/enviados` em cada coluna; depois uma linha por `CAMPOS_META` com o rótulo humano (`em` → "E-mail", `ph` → "Telefone", `fn`/`ln` → "Nome"/"Sobrenome", `external_id` → "ID próprio (sck)", `fbp` → "Cookie _fbp", `fbc` → "Clique (fbc)", `client_ip_address` → "IP", `client_user_agent` → "Navegador", `ct`/`st`/`country` → "Cidade"/"Estado"/"País") e o `%` em cada coluna; para o IC, os campos que ele nunca leva (`em, ph, fn, ln, ct, st, country`) mostram "—" em vez de 0.
- rodapé em `text-[11px] text-[var(--color-muted)]`: "Lido do event_log do tracking. Em funil PayT, cidade/estado/país ficam em 0% — a PayT não manda endereço. A nota oficial é a Qualidade da correspondência no Gerenciador de Eventos."

- [ ] **Step 5: Ver passar** — `npm run check` (491 + 3 = 494).

- [ ] **Step 6: Commit** — `git commit -m "feat: aba Meta no card do dominio — cobertura do user_data enviado a CAPI (7 dias)"`

---

## Task 8: Runbook do dashboard

**Files:**
- Modify: `SETUP.md`

Fase nova (numeração seguinte à última), "Qualidade de correspondência na Meta", curta:

1. Deploy do tracking primeiro (ver `HANDOFF.md` de lá), depois do dashboard. Sem migration, sem SQL.
2. **Recolar o header em todas as páginas de todos os domínios** — aba Header de cada card em `/admin/tracking`. É o que põe o `external_id` no pixel; sem recolar, o navegador continua sem ele (o servidor já manda). Vale para todos os funis, não só os do Google.
3. A aba **Meta** de cada card mostra, nos últimos 7 dias, quantos Purchase e IC saíram, quantos a Meta aceitou, e em que % cada campo foi junto. O que esperar: `em`/`ph`/`external_id`/`fbp`/IP/navegador perto de 100% no Purchase; `fbc` só onde houve `fbclid`; cidade/estado/país só em funil Digistore24.
4. A **série diária de checkouts** da Visão Geral, que vinha do `event_log` e estava zerada, passa a ter dado a partir do deploy do tracking — ela não é retroativa.
5. A nota oficial continua sendo a do Gerenciador de Eventos: anotar antes, comparar depois de 7 dias.

Commit: `git commit -m "docs: fase da qualidade de correspondencia no SETUP (header, aba Meta, serie de checkouts)"`.

---

## Ordem e dependências

Tracking: 1 → 2 → 3 → 4 → 5, em série (2 depende de 1, 3 e 4 de 2). Dashboard: 6 e 7 independentes entre si e do tracking; 8 por último. Deploy: tracking antes do dashboard; header recolado por último.
