# Postback de afiliado da Digistore24 — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gravar em `sales` a comissão das vendas que fazemos como afiliado na Digistore24, para que apareçam na receita do funil SWH no dashboard.

**Architecture:** Um canal de entrada novo — rota GET, normalizador próprio, token na query — reaproveitando o `processarVenda` que já existe. Três mudanças aditivas no núcleo compartilhado, todas inertes quando os campos novos não vêm.

**Tech Stack:** Node puro, CommonJS, Express 4, `pg`, testes com `node --test`.

## Global Constraints

- **Sistema EM PRODUÇÃO.** Este servidor processa vendas reais de 10 funis agora. Uma regressão no caminho da PayT ou do IPN de vendor perde dinheiro.
- Nenhuma dependência npm nova.
- CommonJS (`require`/`module.exports`). Sem TypeScript, sem build.
- Testes em `test/*.test.js`, rodam com `npm test` (`node --test`). Sem rede e sem banco — o padrão do repositório é pool falso, como em `test/vendas.test.js`.
- Comentários **sem acento**, a convenção deste repositório (`nao`, `atribuicao`, `configuracao`). Isto é o oposto da convenção do repositório do dashboard — não confundir.
- Rotas de webhook respondem 200 mesmo em erro de processamento: a alternativa é a Digistore24 reenviar até 20 vezes em 10 dias.
- **Não alterar** a resolução de funil existente (pixel, sck, product_code, funil único), a construção do `event_id`, nem quais eventos vão para a Meta nas plataformas atuais.
- Este repositório distingue `||` de `??` deliberadamente. Uma revisão anterior pegou uma troca que mudou o comportamento para string vazia. Não "limpe" operadores vizinhos.
- Baseline antes de começar: **51 testes passando, 0 falhas.**

---

## Contexto verificado no código

Conferido antes de escrever o plano — não deduzir de novo.

- `vendas.js:9-11` começa com `const { txId, sck, paid, value, total } = venda;` e a resolução de funil abre em `if (venda.pixelId)`.
- `vendas.js:21-22` é `let offerType = null;` seguido de `let sendToMeta = true;   // produto nao cadastrado = envia`.
- O bloco do `product_code` (`vendas.js:23-34`) sobrescreve os dois quando acha produto cadastrado.
- `digistore24.js` **não exporta** `traduzirStatus` hoje: `module.exports = { assinaturaValida, stringParaAssinar, normalizarDigistore }`.
- `STATUS_DIGISTORE` mapeia `payment -> paid`, `refund -> refunded`, `chargeback -> chargeback`, `completed -> paid`, `pending -> pending`, `missed -> pending`.
- `traduzirStatus(p)` lê `p.transaction_type || p.billing_status`. No postback de afiliado os nomes dos parâmetros são escolha nossa, então a URL usa `transactionType` e `status` — o normalizador novo monta o objeto que `traduzirStatus` espera.
- `auth.js` exporta `tokenValido(recebido, esperado)`, comparação em tempo constante, `false` se qualquer um for vazio ou de tamanho diferente.
- `server.js:81-83` registra os body-parsers; `app.get('/health', ...)` está em `server.js:281`; o middleware de erro do body-parser fecha o arquivo.
- Os valores da Digistore24 já vêm em unidade monetária (97.00), não em centavos.

### A URL que o operador vai colar na Digistore24

Os nomes à esquerda do `=` são escolha nossa; os `{...}` à direita são os marcadores da plataforma.

```
https://track.chemistrysystem.com/webhook/digistore24-afiliado?funil=chemistrysystem-fb1&transactionId={transaction_id}&orderId={order_id}&transactionType={transaction_type}&status={billing_status}&currency={currency}&productId={product_id}&productName={product_name}&commission={amount_affiliate_abs}&amountGross={amount_brutto_abs}&country={country}&dateTime={datetime_full}&isTest={is_test}&token=SEU_TOKEN
```

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `digistore24.js` | passa a exportar `traduzirStatus` — nada mais muda |
| `digistore24-afiliado.js` | **novo.** Normaliza a query string do postback. Puro. |
| `test/digistore24-afiliado.test.js` | **novo.** Testes do normalizador. |
| `vendas.js` | três mudanças aditivas no núcleo |
| `test/vendas.test.js` | testes das três mudanças, e a não-regressão da PayT |
| `server.js` | rota `GET /webhook/digistore24-afiliado` |
| `HANDOFF.md` | o que o operador configura: variável, URL, verificação |

---

## Task 1: Normalizador do postback de afiliado

**Files:**
- Modify: `digistore24.js` (só a linha do `module.exports`)
- Create: `digistore24-afiliado.js`
- Test: `test/digistore24-afiliado.test.js`

**Interfaces:**
- Consumes: `traduzirStatus` de `./digistore24`
- Produces: `normalizarAfiliado(q)` — recebe o objeto de query string (`req.query`), devolve o objeto de venda que `processarVenda` consome. Os campos novos que ele produz e que a Task 2 passa a respeitar: `funnelSlug` (string), `enviarMeta` (`false`), `offerType` (`'backend'`).

- [ ] **Step 1: Exportar `traduzirStatus`**

Em `digistore24.js`, trocar a última linha por:

```js
module.exports = { assinaturaValida, stringParaAssinar, normalizarDigistore, traduzirStatus };
```

Nada mais neste arquivo. `traduzirStatus` já existe e já está testado.

- [ ] **Step 2: Escrever os testes que falham**

Criar `test/digistore24-afiliado.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarAfiliado } = require('../digistore24-afiliado');

// Postback de exemplo, com os nomes de parametro que a nossa URL define.
function q(extra = {}) {
  return {
    funil: 'chemistrysystem-fb1',
    transactionId: '123456789',
    orderId: 'ABCD1234',
    transactionType: 'payment',
    status: 'completed',
    currency: 'USD',
    productId: '605054',
    productName: 'Main1 - FLOW (1 Jar)',
    commission: '51.00',
    amountGross: '97.00',
    country: 'US',
    dateTime: '2026-08-30T15:38:45+02:00',
    isTest: '0',
    ...extra,
  };
}

test('a comissao vira value, o bruto vira total', () => {
  const v = normalizarAfiliado(q());
  assert.strictEqual(v.value, 51);
  assert.strictEqual(v.total, 97);
});

test('txId e productCode levam o prefixo ds24a_', () => {
  const v = normalizarAfiliado(q());
  assert.strictEqual(v.txId, 'ds24a_123456789');
  assert.strictEqual(v.productCode, 'ds24a_605054');
});

test('payment vira paid', () => {
  const v = normalizarAfiliado(q());
  assert.strictEqual(v.status, 'paid');
  assert.strictEqual(v.paid, true);
});

test('refund e chargeback traduzem, e nao sao pagos', () => {
  const r = normalizarAfiliado(q({ transactionType: 'refund' }));
  assert.strictEqual(r.status, 'refunded');
  assert.strictEqual(r.paid, false);
  const c = normalizarAfiliado(q({ transactionType: 'chargeback' }));
  assert.strictEqual(c.status, 'chargeback');
  assert.strictEqual(c.paid, false);
});

test('isTest=1 marca teste, qualquer outro valor nao', () => {
  assert.strictEqual(normalizarAfiliado(q({ isTest: '1' })).teste, true);
  assert.strictEqual(normalizarAfiliado(q({ isTest: '0' })).teste, false);
  assert.strictEqual(normalizarAfiliado(q()).teste, false);
});

test('os campos que mandam no nucleo vem fixos', () => {
  const v = normalizarAfiliado(q());
  assert.strictEqual(v.funnelSlug, 'chemistrysystem-fb1');
  assert.strictEqual(v.enviarMeta, false);
  assert.strictEqual(v.offerType, 'backend');
  assert.strictEqual(v.origem, 'digistore24_afiliado');
});

test('o postback nao traz dado de comprador: fica nulo, nao inventado', () => {
  const v = normalizarAfiliado(q());
  assert.strictEqual(v.sck, null);
  assert.strictEqual(v.src, null);
  assert.strictEqual(v.email, null);
  assert.strictEqual(v.phone, null);
  assert.strictEqual(v.ip, null);
  assert.strictEqual(v.pixelId, null);
});

test('sem transactionId, txId fica null em vez de virar o prefixo sozinho', () => {
  const v = normalizarAfiliado(q({ transactionId: undefined }));
  assert.strictEqual(v.txId, null);
});

test('valor ausente ou nao numerico vira 0, nao NaN', () => {
  const v = normalizarAfiliado(q({ commission: undefined, amountGross: 'abc' }));
  assert.strictEqual(v.value, 0);
  assert.strictEqual(v.total, 0);
});

test('entrada vazia nao quebra', () => {
  const v = normalizarAfiliado({});
  assert.strictEqual(v.txId, null);
  assert.strictEqual(v.status, null);
  assert.strictEqual(v.paid, false);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `Cannot find module '../digistore24-afiliado'`

- [ ] **Step 4: Escrever o normalizador**

Criar `digistore24-afiliado.js`:

```js
// =====================================================================
//  digistore24-afiliado.js — normalizacao do Postback S2S de afiliado.
//
//  Canal diferente do IPN de venda (digistore24.js), nao uma variacao dele:
//   - o IPN e configurado pelo vendor dentro do produto; este e configurado
//     na nossa conta e dispara nas vendas dos nossos links, em produto de
//     terceiro;
//   - chega como GET com query string, e os nomes dos parametros sao escolha
//     nossa (montamos a URL no painel);
//   - a nossa receita e a comissao (amount_affiliate_abs), nao a parte do
//     vendedor.
//
//  Funcao pura: sem banco, sem rede.
// =====================================================================
const { traduzirStatus } = require('./digistore24');

// Prefixo proprio, nao o ds24_ do IPN de vendor: se um dia formos vendor e
// afiliado do mesmo produto, o mesmo transaction_id chegaria pelos dois canais
// e as duas linhas colidiriam em sales.transaction_id, a chave de deduplicacao.
const PREFIXO = 'ds24a_';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizarAfiliado(query) {
  const q = (query && typeof query === 'object' && !Array.isArray(query)) ? query : {};

  const txBruto = q.transactionId || null;
  // traduzirStatus le transaction_type || billing_status; a nossa URL manda os
  // mesmos dois valores com outros nomes.
  const status = traduzirStatus({
    transaction_type: q.transactionType,
    billing_status: q.status,
  });

  return {
    origem: 'digistore24_afiliado',
    txId: txBruto ? PREFIXO + txBruto : null,
    txIdBruto: txBruto,
    status,
    paid: status === 'paid',
    teste: q.isTest === '1',
    value: num(q.commission),      // a comissao: a nossa receita nesta venda
    total: num(q.amountGross),     // o que o cliente pagou ao vendedor
    productCode: q.productId ? PREFIXO + q.productId : null,
    productName: q.productName || null,
    country: q.country || null,
    paidAt: q.dateTime || null,
    upsellFrom: q.orderId || null,

    // O funil vem fixo na URL: sem sck e sem produto cadastrado, nada mais
    // resolveria, e venda com funnel_id nulo e invisivel no dashboard.
    funnelSlug: q.funil || null,
    // Comissao de produto de terceiro nao pode inflar a otimizacao das nossas
    // campanhas. Ver vendas.js.
    enviarMeta: false,
    offerType: 'backend',

    // O postback nao traz nada do comprador nem do clique. Nulo honesto e
    // melhor que valor inventado a partir de campo parecido.
    sck: null,
    src: null,
    email: null,
    phone: null,
    city: null,
    state: null,
    nome: null,
    paymentMethod: null,
    ip: null,
    pixelId: null,
  };
}

module.exports = { normalizarAfiliado };
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test`
Expected: PASS — 51 do baseline + 10 novos = 61 passando, 0 falhas.

- [ ] **Step 6: Commit**

```bash
git add digistore24.js digistore24-afiliado.js test/digistore24-afiliado.test.js
git commit -m "feat: normalizador do postback de afiliado da Digistore24"
```

---

## Task 2: Três mudanças no núcleo compartilhado

**Files:**
- Modify: `vendas.js`
- Test: `test/vendas.test.js`

**Interfaces:**
- Consumes: os campos `funnelSlug`, `enviarMeta` e `offerType` que a Task 1 produz.
- Produces: `processarVenda(pool, venda)` com a mesma assinatura. As três mudanças são aditivas: venda sem esses campos se comporta exatamente como hoje.

**Atenção:** este arquivo é usado pelas duas plataformas em produção. Cada mudança abaixo é escrita para ser inerte quando o campo novo não vem. Não reescreva nada além do que os passos pedem.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar ao final de `test/vendas.test.js` (o arquivo já tem `fakePool`, `insertSalesArgs` e `fakePoolComFunil` — reutilize, não duplique):

```js
// Pool falso que resolve funil por SLUG, o caminho do postback de afiliado.
function fakePoolComSlug() {
  const calls = [];
  const funnelRow = { id: 7, slug: 'chemistrysystem-fb1', domain: 'www.chemistrysystem.com',
    pixel_id: '999', capi_token: 'tok', currency: 'USD', active: true };
  return {
    calls,
    async query(text) {
      calls.push({ text });
      if (text.includes('WHERE active AND slug = $1')) return { rows: [funnelRow] };
      if (text.includes('SELECT * FROM funnels WHERE active AND domain')) return { rows: [funnelRow] };
      return { rows: [] };
    },
  };
}

test('funnelSlug resolve o funil sem sck e sem produto cadastrado', async () => {
  const pool = fakePoolComSlug();
  const venda = { txId: 'ds24a_1', funnelSlug: 'chemistrysystem-fb1', sck: null, src: null,
    paid: false, value: 51, total: 97, origem: 'digistore24_afiliado' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[17], 7, 'funnel_id deveria ser o do funil achado pelo slug');
  assert.strictEqual(args[7], 'USD', 'a moeda vem do funil resolvido');
});

test('enviarMeta false nao chama a Meta mesmo com venda paga e funil resolvido', async (t) => {
  const fetchOriginal = global.fetch;
  let chamou = false;
  global.fetch = async () => { chamou = true; return { status: 200, json: async () => ({}) }; };
  t.after(() => { global.fetch = fetchOriginal; });

  const pool = fakePoolComSlug();
  const venda = { txId: 'ds24a_2', funnelSlug: 'chemistrysystem-fb1', sck: null, src: null,
    paid: true, value: 51, total: 97, enviarMeta: false, origem: 'digistore24_afiliado' };
  const r = await processarVenda(pool, venda);
  assert.strictEqual(chamou, false, 'a CAPI nao podia ter sido chamada');
  assert.strictEqual(r.motivo, 'produto_nao_envia_meta');
});

test('offerType da venda e gravado quando nao ha produto cadastrado', async () => {
  const pool = fakePoolComSlug();
  const venda = { txId: 'ds24a_3', funnelSlug: 'chemistrysystem-fb1', sck: null, src: null,
    paid: false, value: 51, total: 97, offerType: 'backend', origem: 'digistore24_afiliado' };
  await processarVenda(pool, venda);
  assert.strictEqual(insertSalesArgs(pool.calls)[18], 'backend');
});

test('venda sem os campos novos se comporta como antes (PayT nao regride)', async () => {
  const pool = fakePool();
  const venda = { txId: 'T10', sck: 'idx_x', src: 'fb1', paid: false, value: 100, total: 100,
    origem: 'payt' };
  await processarVenda(pool, venda);
  const args = insertSalesArgs(pool.calls);
  assert.strictEqual(args[17], null, 'sem funil resolvido, funnel_id segue null');
  assert.strictEqual(args[18], null, 'sem produto cadastrado, offer_type segue null');
  // e nenhuma consulta por slug foi feita
  assert.ok(!pool.calls.some(c => c.text.includes('WHERE active AND slug = $1')));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL nos quatro novos — funil não resolvido pelo slug, CAPI chamada, `offer_type` nulo.

- [ ] **Step 3: Resolução de funil por slug**

Em `vendas.js`, o bloco de resolução hoje abre assim:

```js
  let funnel = null;
  if (venda.pixelId) {
```

Trocar por:

```js
  let funnel = null;
  // Postback de afiliado: a conexao S2S e dedicada a uma parceria, entao o
  // funil vem fixo na URL. Sem sck e sem produto cadastrado, nada abaixo
  // resolveria, e venda com funnel_id nulo e invisivel no dashboard.
  if (venda.funnelSlug) {
    const r = await pool.query(
      'SELECT * FROM funnels WHERE active AND slug = $1 LIMIT 1', [venda.funnelSlug]);
    funnel = r.rows[0] || null;
  }
  if (!funnel && venda.pixelId) {
```

O resto do bloco (`sck`, `product_code`, funil único) não muda.

- [ ] **Step 4: `offerType` inicial e `enviarMeta` terminal**

Trocar:

```js
  let offerType = null;
  let sendToMeta = true;   // produto nao cadastrado = envia
```

por:

```js
  // O produto cadastrado, quando existe, sobrescreve os dois logo abaixo.
  // offerType inicial importa para a venda de afiliado: sem ele o offer_type
  // grava null, e a query de receita do dashboard usa `= 'principal'` e
  // `<> 'principal'` — com null nenhuma das duas e verdadeira, e a venda some
  // das duas quebras.
  let offerType = venda.offerType || null;
  let sendToMeta = true;   // produto nao cadastrado = envia
```

E, logo **depois** do bloco `if (venda.productCode) { ... }` (antes de `if (!funnel)`), acrescentar:

```js
  // Terminal, e por isso vem depois do bloco acima: comissao de produto de
  // terceiro nao vai para a Meta nem se alguem cadastrar esse produto com
  // send_to_meta = true. Inflaria a otimizacao das nossas campanhas.
  if (venda.enviarMeta === false) sendToMeta = false;
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test`
Expected: PASS — 61 do fim da Task 1 + 4 novos = 65 passando, 0 falhas.

- [ ] **Step 6: Commit**

```bash
git add vendas.js test/vendas.test.js
git commit -m "feat: funnelSlug, enviarMeta e offerType no nucleo de vendas"
```

---

## Task 3: Rota do postback

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `normalizarAfiliado` de `./digistore24-afiliado`, `tokenValido` de `./auth`, `processarVenda` de `./vendas`.
- Produces: `GET /webhook/digistore24-afiliado`.

- [ ] **Step 1: Importar o normalizador**

Junto dos outros `require` no topo de `server.js`, depois da linha do `digistore24`:

```js
const { normalizarAfiliado } = require('./digistore24-afiliado');
```

E acrescentar a rota ao cabeçalho de rotas do arquivo, na lista que já existe:

```js
//    GET  /webhook/digistore24-afiliado <- postback S2S de afiliado (comissao)
```

- [ ] **Step 2: Escrever a rota**

Inserir **antes** de `app.get('/health', ...)`:

```js
// ---------------------------------------------------------------------
//  /webhook/digistore24-afiliado — Postback S2S de afiliado.
//  Canal separado do IPN de venda, com tres diferencas deliberadas:
//   - GET com query string: e o unico formato que a Digistore24 oferece aqui,
//     e os nomes dos parametros sao escolha nossa (montamos a URL no painel);
//   - autentica por token na query: o postback nao assina o payload e nao
//     aceita header. Token errado devolve 401 de proposito, para disparar o
//     e-mail de notificacao de erro configurado na conexao;
//   - a venda nunca vai para a Meta (enviarMeta: false no normalizador).
// ---------------------------------------------------------------------
app.get('/webhook/digistore24-afiliado', async (req, res) => {
  try {
    const q = req.query || {};

    if (!tokenValido(String(q.token || ''), process.env.DIGISTORE_AFILIADO_TOKEN || '')) {
      console.warn('AFILIADO_AUTH_NEGADO', JSON.stringify({
        ip: req.ip, presente: !!q.token, tx: q.transactionId || null,
      }));
      return res.sendStatus(401);
    }

    const venda = normalizarAfiliado(q);

    if (!venda.funnelSlug) {
      console.error('AFILIADO_SEM_FUNIL', JSON.stringify({ tx: venda.txIdBruto }));
      return res.send('OK');
    }

    if (!venda.txId) {
      console.error('AFILIADO_SEM_TXID', JSON.stringify(q).slice(0, 500));
      return res.send('OK');
    }

    const CONHECIDOS = ['paid', 'refunded', 'chargeback', 'pending'];
    if (venda.status && !CONHECIDOS.includes(venda.status)) {
      console.warn('AFILIADO_STATUS_DESCONHECIDO', venda.status, venda.txIdBruto);
    }

    if (venda.paid && !(venda.value > 0)) {
      console.error('AFILIADO_SEM_VALOR', JSON.stringify({
        tx: venda.txIdBruto, commission: q.commission,
      }));
    }

    await processarVenda(pool, venda);

    res.send('OK');
  } catch (e) {
    console.error('afiliado webhook error', e);
    // mesmo em erro interno respondemos OK, como nas outras rotas de webhook:
    // a alternativa e a Digistore24 reenviar o mesmo postback que ja falhou.
    res.send('OK');
  }
});
```

- [ ] **Step 3: Verificar sintaxe e suíte**

Run: `node --check server.js && npm test`
Expected: sintaxe OK, 65 passando, 0 falhas (a rota não tem teste próprio — é `express` puro sobre peças já testadas; a verificação real é o postback de teste da Task 4).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: rota GET do postback de afiliado da Digistore24"
```

---

## Task 4: O que o operador configura

**Files:**
- Modify: `HANDOFF.md`

Este arquivo é a ponte com quem opera o Coolify e o painel da Digistore24. Leia as seções vizinhas antes de escrever e siga o formato delas.

- [ ] **Step 1: Acrescentar a seção**

Acrescentar, no lugar que fizer sentido pela numeração existente do arquivo, uma seção com:

1. **A variável.** `DIGISTORE_AFILIADO_TOKEN` no serviço de tracking no Coolify, com *Available at Runtime* marcado. O comando que gera o valor, para copiar do terminal direto para o campo, sem passar por lugar nenhum:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

2. **A URL do postback**, para colar em Digistore24 › Conexão: Postback S2S. Escreva-a no HANDOFF exatamente assim, com o `SEU_TOKEN` no fim e a observação de que ali entra o valor gerado no passo 1 — os nomes à esquerda do `=` são escolha nossa e têm que casar com o que `normalizarAfiliado` lê:

```
https://track.chemistrysystem.com/webhook/digistore24-afiliado?funil=chemistrysystem-fb1&transactionId={transaction_id}&orderId={order_id}&transactionType={transaction_type}&status={billing_status}&currency={currency}&productId={product_id}&productName={product_name}&commission={amount_affiliate_abs}&amountGross={amount_brutto_abs}&country={country}&dateTime={datetime_full}&isTest={is_test}&token=SEU_TOKEN
```

Na conexão, deixe *Moeda* em "Converter valores para USD" — é a moeda do funil SWH, e `processarVenda` grava `funnel.currency` sem converter nada.

3. **Como conferir.** O botão *Testar conexão* do painel da Digistore24 dispara um postback com `isTest=1`. Depois dele:

```bash
node scripts/q.js "SELECT transaction_id, status, value, funnel_id, offer_type, plataforma FROM sales WHERE plataforma = 'digistore24_afiliado' ORDER BY id DESC LIMIT 5"
```

Esperado: uma linha com `plataforma = digistore24_afiliado`, `funnel_id` igual ao do SWH e `offer_type = backend`. Venda de teste grava `capi_response = {"skipped":"modo_teste"}` e não vai para a Meta.

4. **O que registrar como aceito:** o token viaja na query string e aparece em log de acesso do proxy. É o único formato que a Digistore24 oferece neste canal. Rotacionar é trocar a variável e a URL.

5. **O que não fazer:** não cadastrar os produtos da parceria no dashboard. Eles são de terceiro, o `send_to_meta` deles não seria respeitado como salvaguarda (a rota já força), e o cadastro só criaria a impressão de que o IPN de venda está apontado para nós — não está.

- [ ] **Step 2: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: passos do operador para o postback de afiliado"
```

---

## Ordem e dependências

Task 1 produz `normalizarAfiliado` e os três campos novos. Task 2 é a única que toca o núcleo compartilhado, e é a de maior risco — venda real da PayT e do IPN de vendor passa por ali. Task 3 costura as duas. Task 4 é documentação e não tem dependência de código.

Nenhuma task pode ser rodada contra banco: não há Postgres alcançável da máquina de desenvolvimento. Toda verificação é `npm test` e `node --check`.
