# Correções do Tracking CAPI — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os 3 defeitos críticos e os 10 importantes encontrados no code review do servidor de tracking CAPI, sem interromper o processamento de vendas em produção.

**Architecture:** O sistema é um único processo Node/Express (`server.js` + `capi.js` + `normalize.js`) rodando em Docker no Coolify contra um Postgres. Não existe suite de testes, lockfile, nem schema versionado. O plano introduz o mínimo de infraestrutura de verificação (testes com `node:test` da stdlib, zero dependências novas; um Postgres local em Docker com o schema real dumpado da produção) e então aplica as correções em ordem de risco crescente, uma por commit/deploy, cada uma com rollback trivial.

**Tech Stack:** Node 20, Express 4, `pg` 8, Postgres, Docker/Coolify, `node:test` (stdlib), Meta Conversions API v20.0.

## Global Constraints

- Sistema **em produção processando vendas reais**. Nenhuma janela de manutenção disponível.
- Cada task = 1 commit = 1 deploy. Rollback = `git revert` + redeploy no Coolify.
- **Não alterar** o `res.json({ok:true})` / status 200 do webhook em caso de erro interno (decisão deliberada 7). Requisição **não autenticada** é exceção: recebe 401.
- **Não alterar** a ordem de resolução de funil (pixel → sck → product_code → funil único).
- **Não usar** `total_price` como receita. `value` = comissão do produtor.
- Nenhuma dependência npm nova. Testes usam `node:test` da stdlib.
- Datas continuam em TIMESTAMPTZ UTC; conversão para America/Sao_Paulo é do leitor.
- Toda mudança de comportamento que possa descartar dado entra primeiro em **modo shadow** (só loga o que faria) por no mínimo 48h antes de passar a bloquear.

---

## Análise de risco — o que pode quebrar

Esta seção responde diretamente à pergunta "causaria instabilidade?". Leia antes de executar.

| Task | Correção | Risco de quebrar o que funciona | Mitigação embutida no plano |
|---|---|---|---|
| 0 | Infra de verificação | **Nenhum** — não toca código de produção | — |
| 1 | C1 auth (shadow) | **Nenhum** — só loga | — |
| 2 | I1/I4/I5 resiliência | **Baixo** | `trust proxy` por número de hops, não `true` cego |
| 3 | C3 `ON CONFLICT` sales | **Baixo** | Testado contra Postgres local com schema real |
| 4 | I2 store `funnel_id` | **Baixo** | Só adiciona `COALESCE` + log |
| 5 | C1 auth (enforce) | **ALTO** | Ver abaixo |
| 6 | C2 `event_id` | **MÉDIO** | Ver abaixo — exige verificação prévia |
| 7 | I3 alertas + reprocessamento | **MÉDIO** | Depende da Task 6 estar no ar |
| 8 | I7/I8/M4 guards | **Baixo** | Guards entram em shadow primeiro |
| 9 | I9 normalização geo/telefone | **Baixo** | Só muda hash de campos que hoje não casam |
| 10 | I6 CORS + M2 + M7 | **MÉDIO** | Allowlist construída a partir de log real de origens |
| 11 | I10 lockfile + Docker | **MÉDIO** | Lock gerado a partir das versões que já rodam em prod |

### Os três riscos reais, detalhados

**Task 5 (enforce da autenticação) — o maior risco do plano.** Se o token não estiver corretamente configurado no painel da PayT quando o enforce subir, **toda venda passa a ser rejeitada com 401** e some do banco e da Meta. Por isso o plano separa shadow (Task 1) de enforce (Task 5) com no mínimo 48h de observação entre eles, e o enforce fica atrás de uma env var (`PAYT_AUTH_ENFORCE`) que pode ser desligada no Coolify em segundos, sem rebuild. O gate só entra depois que o log de shadow mostrar 100% dos webhooks reais chegando com token válido.

**Task 6 (`event_id`) — risco de contagem dupla.** Hoje o servidor manda `event_id = sck`. Se a página do checkout também dispara um `Purchase` pelo pixel do browser usando o mesmo `sck` como `event_id`, os dois estão sendo deduplicados hoje. Mudar só o lado do servidor quebraria essa dedupe e a Meta passaria a contar **duas** conversões por venda — o oposto do problema atual. A Task 6 começa com um passo de verificação obrigatório que decide entre dois caminhos. **Não execute a Task 6 sem completar esse passo.**

**Task 11 (lockfile) — risco de subir versões não testadas.** Gerar `package-lock.json` hoje na sua máquina pina o que o npm resolve *hoje*, que pode ser diferente do que está rodando em produção há meses. A task extrai as versões reais do container antes de gerar o lock.

### O que este plano deliberadamente NÃO faz

- Não mexe no `res.json` 200 do erro interno.
- Não reescreve a resolução de funil.
- Não remove o `console.log('PAYT_WEBHOOK')` (é proposital e temporário — só sugere a versão redigida na Task 8, comentada, para quando você decidir remover).
- Não trata reembolso/chargeback na Meta (fora de escopo; anotado como pendência).
- Não migra para framework de teste, TypeScript, ORM ou qualquer coisa do tipo.

---

## Estrutura de arquivos

| Arquivo | Estado | Responsabilidade |
|---|---|---|
| `server.js` | Modificar | Rotas, resolução de funil, persistência. Continua sendo o arquivo único de orquestração. |
| `capi.js` | Modificar | Cliente da Meta. Ganha `buildPurchaseEvent()` exportado (extração pura, sem mudança de comportamento) para permitir teste sem rede. |
| `normalize.js` | Não muda | — |
| `auth.js` | **Criar** | Uma função: comparação de token em tempo constante. Existe separado só para ser testável. ~12 linhas. |
| `geo.js` | **Criar** | Normalização de cidade/estado/país/telefone no formato que a Meta exige. ~25 linhas. |
| `schema.sql` | **Criar** | DDL real dumpado da produção. Documentação executável + base para o Postgres de teste. |
| `test/capi.test.js` | **Criar** | Testes de `buildPurchaseEvent` e da normalização. `node:test`. |
| `test/auth.test.js` | **Criar** | Testes da comparação de token. |
| `test/sql.test.sh` | **Criar** | Script que sobe Postgres em Docker, aplica `schema.sql` e verifica os `ON CONFLICT` com casos reais. |
| `scripts/reprocessa-capi.js` | **Criar** | Rotina de reenvio de vendas pagas que não chegaram à Meta. |
| `package.json` | Modificar | Adiciona `"test": "node --test test/"`. Nenhuma dependência nova. |
| `package-lock.json` | **Criar** | Build reproduzível. |
| `Dockerfile` | Modificar | `npm ci`, `USER node`. |
| `README.md` | Modificar | Env vars, deploy, schema, runbook. |

---

## Task 0: Infraestrutura de verificação

Não toca em nada de produção. Existe para que as tasks seguintes possam ser verificadas antes de subir.

**Files:**
- Create: `schema.sql`
- Create: `test/capi.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm test` executável; `schema.sql` aplicável num Postgres vazio.

- [ ] **Step 1: Dumpar o schema real da produção**

Rode na sua máquina, com a `DATABASE_URL` de produção (a mesma que está no Coolify):

```bash
pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > schema.sql
```

Se o Postgres não estiver exposto para fora, rode de dentro do container no Coolify e copie o resultado. Confira que o arquivo contém as 6 tabelas: `funnels`, `sales`, `clicks`, `store`, `event_log`, `products`.

- [ ] **Step 2: Verificar as premissas que o review não pôde confirmar**

Rode estas queries contra produção e anote as respostas — três tasks dependem delas:

```sql
-- (a) transaction_id vem sempre preenchido? (premissa da Task 8)
SELECT count(*) FILTER (WHERE transaction_id IS NULL) AS nulos, count(*) AS total FROM sales;

-- (b) existem vendas pagas com value zerado? (confirma o impacto do C3)
SELECT count(*) FROM sales WHERE status='paid' AND (value IS NULL OR value = 0);

-- (c) existem vendas pagas sem funil? (confirma o impacto do I2)
SELECT count(*) FROM sales WHERE status='paid' AND funnel_id IS NULL;

-- (d) existem linhas em store sem funnel_id? (confirma o impacto do I2)
SELECT count(*) FILTER (WHERE funnel_id IS NULL) AS sem_funil, count(*) AS total FROM store;

-- (e) o que está gravado em state/country? sigla ou nome? (define a Task 9)
SELECT state, country, count(*) FROM store GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;

-- (f) existem event_id repetidos? (confirma o impacto do C2)
SELECT event_id, count(*) FROM sales GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 20;

-- (g) vendas pagas que nunca chegaram à Meta (backlog para a Task 7)
SELECT count(*) FROM sales WHERE status='paid' AND capi_sent IS NOT TRUE;

-- (h) paid_at está coerente? compare com o horário real de uma venda conhecida
SELECT transaction_id, paid_at, created_at FROM sales WHERE status='paid' ORDER BY created_at DESC LIMIT 5;

-- (i) tem índice em clicks(sck)? (M10)
SELECT indexdef FROM pg_indexes WHERE tablename='clicks';
```

Se **(f)** retornar linhas, o C2 já está causando perda de conversão hoje — a Task 6 sobe de prioridade. Se **(h)** mostrar `paid_at` 3h à frente do horário real, o M6 se confirma.

- [ ] **Step 3: Adicionar o script de teste**

Em `package.json`, dentro de `"scripts"`:

```json
  "scripts": { "start": "node server.js", "test": "node --test test/" },
```

- [ ] **Step 4: Escrever um teste que passa, só para validar o encanamento**

Crie `test/capi.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { hash, hashPhone } = require('../capi');

test('hash normaliza trim e lowercase antes do sha256', () => {
  assert.strictEqual(hash('  Foo@Bar.COM '), hash('foo@bar.com'));
});

test('hash devolve undefined para vazio', () => {
  assert.strictEqual(hash(''), undefined);
  assert.strictEqual(hash(null), undefined);
});

test('hashPhone remove nao-digitos', () => {
  assert.strictEqual(hashPhone('(11) 98888-7777'), hash('11988887777'));
});
```

- [ ] **Step 5: Rodar os testes**

```bash
npm test
```

Esperado: 3 testes passando. Se `node --test test/` reclamar da versão, confirme `node -v` ≥ 20.

- [ ] **Step 6: Subir Postgres local com o schema real**

```bash
docker run -d --name tracking-test -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16
sleep 5
psql "postgresql://postgres:test@localhost:55432/postgres" -f schema.sql
```

Esperado: nenhum erro. Guarde a URL `postgresql://postgres:test@localhost:55432/postgres` — as tasks de SQL usam.

- [ ] **Step 7: Commit**

```bash
git add schema.sql package.json test/capi.test.js
git commit -m "chore: versiona schema e adiciona testes com node:test"
```

Este commit **não precisa de deploy** — não altera comportamento em runtime.

---

## Task 1: C1 — autenticação do webhook em modo shadow

Só observa. Nenhuma requisição é bloqueada. O objetivo é provar, com dado real, que o token está configurado corretamente antes de ligar o enforce na Task 5.

**Files:**
- Create: `auth.js`
- Create: `test/auth.test.js`
- Modify: `server.js:112-118`

**Interfaces:**
- Produces: `tokenValido(recebido, esperado) -> boolean` — comparação em tempo constante, `false` se qualquer um for vazio ou os tamanhos diferirem.

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/auth.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { tokenValido } = require('../auth');

test('aceita token identico', () => {
  assert.strictEqual(tokenValido('abc123', 'abc123'), true);
});

test('rejeita token diferente do mesmo tamanho', () => {
  assert.strictEqual(tokenValido('abc123', 'abc124'), false);
});

test('rejeita tamanhos diferentes sem lancar', () => {
  assert.strictEqual(tokenValido('abc', 'abc123'), false);
});

test('rejeita vazio, null e undefined dos dois lados', () => {
  assert.strictEqual(tokenValido('', 'abc123'), false);
  assert.strictEqual(tokenValido('abc123', ''), false);
  assert.strictEqual(tokenValido(null, 'abc123'), false);
  assert.strictEqual(tokenValido('abc123', undefined), false);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npm test
```

Esperado: FAIL com `Cannot find module '../auth'`.

- [ ] **Step 3: Implementar `auth.js`**

```js
// =====================================================================
//  auth.js — comparação de segredo em tempo constante
// =====================================================================
const crypto = require('crypto');

// true só se ambos forem strings não-vazias, de mesmo tamanho e iguais.
// timingSafeEqual lança se os buffers tiverem tamanhos diferentes, por isso
// o tamanho é checado antes.
function tokenValido(recebido, esperado) {
  if (typeof recebido !== 'string' || typeof esperado !== 'string') return false;
  if (!recebido || !esperado) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { tokenValido };
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
npm test
```

Esperado: 7 testes passando (3 da Task 0 + 4 novos).

- [ ] **Step 5: Ligar o shadow no webhook**

Em `server.js`, adicione o require junto aos outros (linha 12):

```js
const { tokenValido } = require('./auth');
```

E logo depois do `const p = req.body || {};` (linha 114), **antes** do log `PAYT_WEBHOOK`:

```js
    // SHADOW: ainda não bloqueia. Só registra se o token bateria.
    // O enforce é ligado na Task 5, via PAYT_AUTH_ENFORCE=1.
    const tokenRecebido = req.get('x-payt-token') || req.query.t || '';
    const tokenOk = tokenValido(tokenRecebido, process.env.PAYT_WEBHOOK_TOKEN);
    console.log('PAYT_AUTH', JSON.stringify({
      ok: tokenOk,
      presente: !!tokenRecebido,
      ip: req.ip,
      tx: p?.transaction_id || null,
    }));
```

- [ ] **Step 6: Definir o token no Coolify**

Gere um token e cadastre como variável de ambiente `PAYT_WEBHOOK_TOKEN` na aplicação:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Ainda não mexa na PayT.** Guarde o valor.

- [ ] **Step 7: Testar localmente antes de subir**

```bash
PAYT_WEBHOOK_TOKEN=segredo123 DATABASE_URL="postgresql://postgres:test@localhost:55432/postgres" node server.js &
curl -s -X POST "http://localhost:3000/webhook/payt?t=segredo123" -H 'Content-Type: application/json' -d '{"transaction_id":"TESTE1","status":"pending"}'
curl -s -X POST "http://localhost:3000/webhook/payt?t=errado" -H 'Content-Type: application/json' -d '{"transaction_id":"TESTE2","status":"pending"}'
```

Esperado: os dois respondem `{"ok":true}` (shadow não bloqueia), e o log mostra `PAYT_AUTH {"ok":true,...}` no primeiro e `{"ok":false,...}` no segundo.

- [ ] **Step 8: Commit e deploy**

```bash
git add auth.js test/auth.test.js server.js
git commit -m "feat: log shadow de autenticacao do webhook payt"
```

Deploy no Coolify. **Risco: nenhum** — nenhuma requisição é rejeitada.

- [ ] **Step 9: Configurar a URL na PayT**

No painel da PayT, altere a URL do webhook de `https://track.<dominio>/webhook/payt` para `https://track.<dominio>/webhook/payt?t=<TOKEN>`.

Se a PayT permitir header customizado, prefira `x-payt-token: <TOKEN>` — o token na query aparece nos logs de acesso do proxy. Se só aceitar URL, use a query mesmo; o token é rotacionável.

- [ ] **Step 10: Observar por 48h**

Depois de pelo menos 48h e algumas dezenas de vendas reais, verifique nos logs do Coolify:

```
PAYT_AUTH {"ok":true,...}
```

**Critério para prosseguir à Task 5:** 100% dos `PAYT_AUTH` com `ok:true` no período, e nenhum `ok:false` cujo `tx` corresponda a uma venda real. Qualquer `ok:false` com transação real significa que existe uma segunda origem de webhook que você não configurou — investigue antes.

---

## Task 2: I1 + I4 + I5 — as três linhas de resiliência

Três modos de falha independentes, três correções pequenas, um deploy.

**Files:**
- Modify: `server.js:14-15` (pool error, trust proxy)
- Modify: `server.js:83, 95` (prioridade do IP)
- Modify: `capi.js:78-82` (timeout)

- [ ] **Step 1: Handler de erro do pool e do processo**

Em `server.js`, logo depois da linha 14 (`const pool = new Pool(...)`):

```js
// Um client ocioso que recebe erro do backend (restart do Postgres, failover,
// redeploy do banco) faz o Pool emitir 'error'. EventEmitter sem listener em
// 'error' LANÇA e mata o processo — e isso acontece fora de qualquer try/catch.
pool.on('error', (err) => console.error('PG_POOL_ERROR', err));
process.on('unhandledRejection', (err) => console.error('UNHANDLED_REJECTION', err));
```

- [ ] **Step 2: `trust proxy` com número de hops**

Depois do `const app = express();` (linha 15):

```js
// Atrás do Traefik/Coolify. Sem isto, req.ip devolve o IP da rede interna do
// Docker (172.x), que vai parar em client_ip_address na CAPI e derruba o match.
// 1 = confia apenas no proxy imediato (não em X-Forwarded-For arbitrário).
app.set('trust proxy', 1);
```

Use `1` e não `true`: `true` confia na cadeia inteira de `X-Forwarded-For`, o que permite ao cliente forjar o IP. Se houver Cloudflare **na frente** do Traefik, use `2`.

- [ ] **Step 3: Preferir o IP real ao IP do corpo**

`b.ip` vem do browser e é spoofável. Trocar a ordem nas duas queries.

`server.js:83`, trocar `b.ip || req.ip` por:

```js
       req.ip || b.ip,
```

`server.js:95`, mesma troca:

```js
      [b.sck, b.src, b.fbp, b.fbc, b.fbclid, req.ip || b.ip,
```

- [ ] **Step 4: Timeout no fetch da Meta**

Em `capi.js:78-82`, substituir por:

```js
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // undici não tem timeout de request por padrão (só headersTimeout ~5min).
    // O loop de pixels em server.js é sequencial, então o pior caso soma.
    signal: AbortSignal.timeout(8000),
  });
```

O `try/catch` por pixel em `server.js:256-266` já captura o `TimeoutError` e o registra em `resultados`. Nenhuma outra mudança é necessária.

- [ ] **Step 5: Verificar o timeout localmente**

```bash
node -e "
const t = Date.now();
fetch('https://httpbin.org/delay/20', { signal: AbortSignal.timeout(8000) })
  .then(() => console.log('FALHOU: nao deu timeout'))
  .catch(e => console.log('ok, abortou em', Date.now()-t, 'ms:', e.name));
"
```

Esperado: `ok, abortou em ~8000 ms: TimeoutError`.

- [ ] **Step 6: Verificar `trust proxy` localmente**

```bash
node server.js &
curl -s -X POST http://localhost:3000/collect -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 203.0.113.9' -d '{"sck":"idx_teste_trust"}'
psql "postgresql://postgres:test@localhost:55432/postgres" -c "SELECT sck, ip_override FROM store WHERE sck='idx_teste_trust'"
```

Esperado: `ip_override` = `203.0.113.9`, não `127.0.0.1`.

- [ ] **Step 7: Commit e deploy**

```bash
git add server.js capi.js
git commit -m "fix: pool error handler, trust proxy e timeout no fetch da CAPI"
```

**Risco: baixo.** O único efeito visível é que `store.ip_override` passa a guardar o IP público correto em vez do IP interno do Docker — que é o comportamento desejado. Vendas antigas não são afetadas.

---

## Task 3: C3 — `ON CONFLICT` completo em `sales`

**Files:**
- Modify: `server.js:224-227`
- Create: `test/sql.test.sh`

- [ ] **Step 1: Escrever o teste SQL que falha**

Crie `test/sql.test.sh`:

```bash
#!/usr/bin/env bash
# Verifica o ON CONFLICT de sales com o schema real.
# Uso: DATABASE_URL=... ./test/sql.test.sh
set -euo pipefail
DB="${DATABASE_URL:-postgresql://postgres:test@localhost:55432/postgres}"

psql "$DB" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DELETE FROM sales WHERE transaction_id = 'TESTE_ONCONFLICT';

-- webhook 1: waiting_payment, sem comissao, sem sck, sem funil
INSERT INTO sales (transaction_id, status, value, sck, funnel_id, customer_email)
VALUES ('TESTE_ONCONFLICT', 'waiting_payment', 0, NULL, NULL, NULL);

-- webhook 2: paid, com comissao e atribuicao
INSERT INTO sales (transaction_id, status, value, sck, funnel_id, customer_email)
VALUES ('TESTE_ONCONFLICT', 'paid', 97.00, 'idx_abc', 1, 'x@y.com')
ON CONFLICT (transaction_id) DO UPDATE SET
  status = EXCLUDED.status,
  value = GREATEST(COALESCE(EXCLUDED.value,0), COALESCE(sales.value,0)),
  sck = COALESCE(sales.sck, EXCLUDED.sck),
  funnel_id = COALESCE(sales.funnel_id, EXCLUDED.funnel_id),
  customer_email = COALESCE(EXCLUDED.customer_email, sales.customer_email);

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM sales WHERE transaction_id='TESTE_ONCONFLICT';
  ASSERT r.status = 'paid',            'status deveria ser paid, veio: '  || r.status;
  ASSERT r.value  = 97.00,             'value deveria ser 97, veio: '     || r.value;
  ASSERT r.sck    = 'idx_abc',         'sck deveria ser idx_abc';
  ASSERT r.funnel_id = 1,              'funnel_id deveria ser 1';
  ASSERT r.customer_email = 'x@y.com', 'email deveria ter sido preenchido';
END $$;

ROLLBACK;
SQL
echo "OK: ON CONFLICT preserva atribuicao e recupera valor"
```

Torne executável: `chmod +x test/sql.test.sh`

- [ ] **Step 2: Rodar contra o `ON CONFLICT` atual e ver falhar**

Edite temporariamente o `ON CONFLICT` do script para a versão **atual** (só `status`, `offer_type`, `payment_method`, `paid_at`) e rode:

```bash
./test/sql.test.sh
```

Esperado: FAIL com `value deveria ser 97, veio: 0`. Isso demonstra o bug em dado real. Desfaça a edição temporária.

**Nota:** o teste usa `funnel_id = 1`, que precisa existir em `funnels`. Se o seu `schema.sql` não trouxer dados, insira um funil de teste no início do bloco: `INSERT INTO funnels (id, slug, domain, active) VALUES (1,'teste','teste.com',true) ON CONFLICT DO NOTHING;`

- [ ] **Step 3: Aplicar o `ON CONFLICT` completo**

Em `server.js:224-227`, substituir o bloco `ON CONFLICT` por:

```sql
       ON CONFLICT (transaction_id) DO UPDATE SET
         status = EXCLUDED.status,
         -- valor: nunca deixa um 0 (webhook pre-pagamento) apagar o valor real
         value = GREATEST(COALESCE(EXCLUDED.value,0), COALESCE(sales.value,0)),
         total_price = GREATEST(COALESCE(EXCLUDED.total_price,0), COALESCE(sales.total_price,0)),
         -- atribuicao: o PRIMEIRO valor nao-nulo vence (o clique original e a verdade)
         sck = COALESCE(sales.sck, EXCLUDED.sck),
         src = COALESCE(sales.src, EXCLUDED.src),
         funnel_id = COALESCE(sales.funnel_id, EXCLUDED.funnel_id),
         utm_source = COALESCE(sales.utm_source, EXCLUDED.utm_source),
         utm_campaign = COALESCE(sales.utm_campaign, EXCLUDED.utm_campaign),
         campaign_id = COALESCE(sales.campaign_id, EXCLUDED.campaign_id),
         adset_id = COALESCE(sales.adset_id, EXCLUDED.adset_id),
         ad_id = COALESCE(sales.ad_id, EXCLUDED.ad_id),
         city = COALESCE(sales.city, EXCLUDED.city),
         state = COALESCE(sales.state, EXCLUDED.state),
         country = COALESCE(sales.country, EXCLUDED.country),
         customer_ip = COALESCE(sales.customer_ip, EXCLUDED.customer_ip),
         -- estado da transacao: o MAIS RECENTE nao-nulo vence
         customer_email = COALESCE(EXCLUDED.customer_email, sales.customer_email),
         customer_phone = COALESCE(EXCLUDED.customer_phone, sales.customer_phone),
         offer_type = COALESCE(EXCLUDED.offer_type, sales.offer_type),
         payment_method = COALESCE(EXCLUDED.payment_method, sales.payment_method),
         paid_at = COALESCE(EXCLUDED.paid_at, sales.paid_at)
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

```bash
./test/sql.test.sh
```

Esperado: `OK: ON CONFLICT preserva atribuicao e recupera valor`.

- [ ] **Step 5: Corrigir as vendas já corrompidas**

Só rode depois do deploy. Identifica vendas pagas com `value=0` que têm um clique atribuível:

```sql
-- primeiro INSPECIONE, não atualize às cegas
SELECT s.transaction_id, s.value, s.sck, s.funnel_id, s.created_at
FROM sales s
WHERE s.status='paid' AND (s.value IS NULL OR s.value = 0)
ORDER BY s.created_at DESC;
```

Cada linha aqui é receita que o painel está reportando como zero. O `value` correto só existe no payload original da PayT — não é recuperável do banco. Se precisar do histórico correto, exporte o relatório de comissões da PayT e reconcilie por `transaction_id`. Recuperar o `funnel_id` e o `sck` é possível pelo `store`:

```sql
UPDATE sales s SET funnel_id = st.funnel_id
FROM store st WHERE st.sck = s.sck AND s.funnel_id IS NULL AND st.funnel_id IS NOT NULL;
```

- [ ] **Step 6: Commit e deploy**

```bash
git add server.js test/sql.test.sh
git commit -m "fix: ON CONFLICT de sales preserva atribuicao e recupera valor"
```

**Risco: baixo.** O `UPDATE` passa a tocar mais colunas, mas cada uma com `COALESCE` que só escreve onde havia NULL, ou `GREATEST` que nunca reduz o valor. Nenhum dado bom existente pode ser sobrescrito por esta mudança. O efeito colateral conhecido: se uma venda for **estornada** e a PayT reenviar com comissão menor, o `GREATEST` mantém o valor antigo — hoje o comportamento já é esse (o valor nem era atualizado), então não é regressão. Tratamento de estorno fica como pendência.

---

## Task 4: I2 — `funnel_id` recuperável em `store` + log de funil não resolvido

**Files:**
- Modify: `server.js:78-82` (ON CONFLICT de store)
- Modify: `server.js:67` (log)

- [ ] **Step 1: Adicionar `funnel_id` ao `ON CONFLICT` de `store`**

Em `server.js:78-82`, ao final da lista de `SET`, adicionar:

```sql
         city=EXCLUDED.city, state=EXCLUDED.state, country=EXCLUDED.country,
         -- funnel_id era a UNICA coluna omitida aqui. Uma linha nascida com
         -- funil NULL nunca se recuperava, e a atribuicao caia no fallback por
         -- product_code — que manda a venda para o pixel do dominio errado.
         funnel_id=COALESCE(store.funnel_id, EXCLUDED.funnel_id)
```

- [ ] **Step 2: Logar quando o funil não resolve**

Em `server.js`, logo após a linha 67 (`const funnel = await funnelByDomain(host);`):

```js
    if (!funnel) console.warn('FUNIL_NAO_RESOLVIDO', JSON.stringify({ host, sck: b.sck || null }));
```

- [ ] **Step 3: Verificar localmente**

```bash
node server.js &
# primeiro collect com host desconhecido -> funnel_id NULL
curl -s -X POST http://localhost:3000/collect -H 'Content-Type: application/json' \
  -H 'X-Forwarded-Host: dominio-inexistente.com' -d '{"sck":"idx_recupera"}'
# segundo collect com host cadastrado -> deve preencher o funnel_id
curl -s -X POST http://localhost:3000/collect -H 'Content-Type: application/json' \
  -H 'X-Forwarded-Host: track.teste.com' -d '{"sck":"idx_recupera"}'
psql "postgresql://postgres:test@localhost:55432/postgres" -c "SELECT sck, funnel_id FROM store WHERE sck='idx_recupera'"
```

Esperado: log `FUNIL_NAO_RESOLVIDO` no primeiro curl, e `funnel_id` preenchido após o segundo. (Requer um funil com `domain='teste.com'` cadastrado no banco local.)

- [ ] **Step 4: Commit e deploy**

```bash
git add server.js
git commit -m "fix: store recupera funnel_id e loga funil nao resolvido"
```

- [ ] **Step 5: Recuperar `funnel_id` das linhas antigas de `store`**

Depois do deploy, para linhas que já nasceram NULL — só é possível onde houver um clique com funil na mesma `sck`:

```sql
UPDATE store st SET funnel_id = c.funnel_id
FROM (SELECT DISTINCT ON (sck) sck, funnel_id FROM clicks
      WHERE funnel_id IS NOT NULL ORDER BY sck, created_at DESC) c
WHERE c.sck = st.sck AND st.funnel_id IS NULL;
```

Rode primeiro como `SELECT` para ver quantas linhas seriam afetadas.

**Risco: baixo.** Só preenche NULLs.

---

## Task 5: C1 — enforce da autenticação

**Só execute depois de cumprir o critério do Step 10 da Task 1.**

**Files:**
- Modify: `server.js` (bloco de shadow adicionado na Task 1)

- [ ] **Step 1: Reconfirmar o critério de liberação**

Nos logs do Coolify, das últimas 48h: todo `PAYT_AUTH` tem `ok:true`? Existe algum `ok:false` com `tx` de venda real? Se sim, **pare** e investigue a origem antes de continuar.

- [ ] **Step 2: Transformar o shadow em gate**

Substituir o bloco de shadow da Task 1 por:

```js
    // Gate de autenticação. A politica de "sempre 200" cobre ERRO INTERNO;
    // requisicao nao autenticada nao e a PayT e recebe 401.
    // Desligavel em segundos pelo Coolify: PAYT_AUTH_ENFORCE=0, sem rebuild.
    const tokenRecebido = req.get('x-payt-token') || req.query.t || '';
    const tokenOk = tokenValido(tokenRecebido, process.env.PAYT_WEBHOOK_TOKEN);
    if (!tokenOk) {
      console.warn('PAYT_AUTH_NEGADO', JSON.stringify({
        ip: req.ip, presente: !!tokenRecebido, tx: p?.transaction_id || null,
      }));
      if (process.env.PAYT_AUTH_ENFORCE === '1') return res.sendStatus(401);
    }
```

- [ ] **Step 3: Verificar localmente que bloqueia**

```bash
PAYT_WEBHOOK_TOKEN=segredo123 PAYT_AUTH_ENFORCE=1 node server.js &
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3000/webhook/payt?t=segredo123" \
  -H 'Content-Type: application/json' -d '{"transaction_id":"T_OK","status":"pending"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3000/webhook/payt?t=errado" \
  -H 'Content-Type: application/json' -d '{"transaction_id":"T_MAU","status":"pending"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3000/webhook/payt" \
  -H 'Content-Type: application/json' -d '{"transaction_id":"T_SEM","status":"pending"}'
psql "postgresql://postgres:test@localhost:55432/postgres" -c "SELECT transaction_id FROM sales WHERE transaction_id LIKE 'T_%'"
```

Esperado: `200`, `401`, `401`. E **apenas** `T_OK` gravado no banco — nenhuma escrita aconteceu nas requisições rejeitadas.

- [ ] **Step 4: Deploy com o enforce DESLIGADO**

```bash
git add server.js
git commit -m "feat: gate de autenticacao no webhook payt (atras de PAYT_AUTH_ENFORCE)"
```

Suba com `PAYT_AUTH_ENFORCE` **ausente ou `0`**. O código novo está no ar mas continua só logando. Confirme que as vendas continuam entrando normalmente.

- [ ] **Step 5: Ligar o enforce**

No Coolify, defina `PAYT_AUTH_ENFORCE=1` e reinicie a aplicação (só restart, sem rebuild).

- [ ] **Step 6: Validar imediatamente com uma venda real**

Faça uma compra de teste real na PayT (valor mínimo) e confirme, em até 5 minutos:

```sql
SELECT transaction_id, status, value, funnel_id, capi_sent FROM sales ORDER BY created_at DESC LIMIT 3;
```

Esperado: a venda aparece com `capi_sent = true`. Se **não** aparecer, desligue o enforce agora (`PAYT_AUTH_ENFORCE=0` + restart) e volte para o shadow — a URL na PayT não está com o token.

- [ ] **Step 7: Monitorar por 24h**

Procure `PAYT_AUTH_NEGADO` nos logs. Entradas com `tx: null` e IPs desconhecidos são varredura da internet — exatamente o que o gate existe para barrar. Entradas com `tx` preenchido significam venda real sendo rejeitada: desligue o enforce e investigue.

**Risco: ALTO, mitigado.** Este é o único ponto do plano onde um erro de configuração para de gravar vendas. As três camadas de proteção são: (1) 48h de shadow provando que o token chega, (2) deploy do código com enforce desligado, separado do momento de ligar, (3) kill switch por env var que não exige rebuild. O tempo máximo de exposição a uma falha é o tempo entre o Step 5 e a validação do Step 6 — minutos, com você olhando.

---

## Task 6: C2 — `event_id` derivado da transação

**Esta task tem um passo de verificação bloqueante. Não pule o Step 1.**

**Files:**
- Modify: `capi.js:63-73` (extração de `buildPurchaseEvent` + troca do `event_id`)
- Modify: `server.js:228, 262`
- Modify: `test/capi.test.js`

**Interfaces:**
- Produces: `buildPurchaseEvent({ funnel, sale, store }) -> object` — monta o evento sem enviar. `sendPurchase` passa a usá-la. Exportada só para teste.

- [ ] **Step 1: VERIFICAÇÃO BLOQUEANTE — existe Purchase disparado pelo browser?**

Abra o Gerenciador de Eventos da Meta → seu pixel → aba "Visão geral". Procure o evento `Purchase` e veja a coluna de origem/conexão.

- **Caso A — `Purchase` só aparece como "Servidor":** o `event_id` não é compartilhado com ninguém. Siga direto para o Step 2. Risco baixo.
- **Caso B — `Purchase` aparece como "Navegador" ou "Navegador e servidor":** existe um pixel disparando Purchase na página de obrigado. Mudar só o lado do servidor **quebra a dedupe e passa a contar duas conversões por venda**. Antes de continuar, você precisa alinhar os dois lados: a página de obrigado precisa passar a usar `eventID: 'purchase_' + <transaction_id>`. O `transaction_id` normalmente vem na URL de retorno da PayT. Se não conseguir alterar a página, **não execute esta task** — o ganho de C2 não compensa a contagem dupla. Documente a decisão e siga para a Task 7 sem ela (e sem a rotina de reprocessamento, que depende desta).

Anote qual caso se aplica antes de prosseguir.

- [ ] **Step 2: Escrever o teste que falha**

Adicione a `test/capi.test.js`:

```js
const { buildPurchaseEvent } = require('../capi');

const funnelFake = { pixel_id: '123', capi_token: 'tok', currency: 'BRL' };

test('event_id deriva da transacao, nao do sck', () => {
  const ev = buildPurchaseEvent({
    funnel: funnelFake,
    sale: { transaction_id: 'T1', value: 97, customer_email: 'a@b.com' },
    store: { sck: 'idx_abc' },
  });
  assert.strictEqual(ev.event_id, 'purchase_T1');
});

test('duas transacoes do mesmo sck geram event_id diferentes', () => {
  const store = { sck: 'idx_abc' };
  const a = buildPurchaseEvent({ funnel: funnelFake, sale: { transaction_id: 'T1', value: 97 }, store });
  const b = buildPurchaseEvent({ funnel: funnelFake, sale: { transaction_id: 'T2', value: 47 }, store });
  assert.notStrictEqual(a.event_id, b.event_id);
});

test('mesma transacao gera sempre o mesmo event_id (reenvio idempotente)', () => {
  const s = { transaction_id: 'T9', value: 10 };
  const a = buildPurchaseEvent({ funnel: funnelFake, sale: s, store: null });
  const b = buildPurchaseEvent({ funnel: funnelFake, sale: s, store: null });
  assert.strictEqual(a.event_id, b.event_id);
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
npm test
```

Esperado: FAIL com `buildPurchaseEvent is not a function`.

- [ ] **Step 4: Extrair `buildPurchaseEvent` e trocar o `event_id`**

Em `capi.js`, substituir o corpo de `sendPurchase` (linhas 36-85) por:

```js
// monta o evento Purchase (puro, sem rede — exportado para teste)
function buildPurchaseEvent({ funnel, sale, store }) {
  const { fn, ln } = splitName(sale.customer_name);

  const user_data = clean({
    em: hash(sale.customer_email),
    ph: hashPhone(sale.customer_phone),
    fn, ln,
    ct: hash(store?.city),
    st: hash(store?.state),
    country: hash(store?.country),
    client_user_agent: store?.user_agent || undefined,
    client_ip_address: store?.ip_override || undefined,
    fbc: store?.fbc || undefined,
    fbp: store?.fbp || undefined,
    external_id: store?.external_id ? hash(store.external_id) : undefined,
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
    event_time: Math.floor(Date.now() / 1000),
    // event_id derivado da TRANSACAO, nao do sck. O sck identifica a sessao:
    // uma compra + um upsell na mesma sessao geravam o mesmo event_id e a Meta
    // descartava o segundo. A dedupe da Meta so opera entre eventos de mesmo
    // event_name, entao compartilhar o id com o InitiateCheckout nao trazia
    // beneficio nenhum. Reenvio do mesmo webhook continua deduplicado.
    event_id: 'purchase_' + sale.transaction_id,
    action_source: 'website',
    event_source_url: store?.page_location || undefined,
    user_data,
    custom_data,
  });
}

// monta e envia o evento Purchase para a CAPI
async function sendPurchase({ funnel, sale, store }) {
  const event = buildPurchaseEvent({ funnel, sale, store });

  const url = `${GRAPH}/${funnel.pixel_id}/events?access_token=${funnel.capi_token}`;
  const body = { data: [event] };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, response: json, payload: event };
}
```

E na última linha do arquivo:

```js
module.exports = { sendPurchase, buildPurchaseEvent, hash, hashPhone };
```

- [ ] **Step 5: Alinhar o `event_id` gravado no banco**

`server.js:228`, trocar `(sck || 'purchase_' + txId)` por:

```js
      [txId, 'purchase_' + txId, sck, src, (p?.transaction?.payment_status || p?.status),
```

`server.js:262`, mesma troca:

```js
            ['purchase_' + txId, src, f.id, r.httpStatus, JSON.stringify(r.payload)]
```

- [ ] **Step 6: Rodar e confirmar que passa**

```bash
npm test
```

Esperado: 13 testes passando.

- [ ] **Step 7: Commit e deploy**

```bash
git add capi.js server.js test/capi.test.js
git commit -m "fix: event_id deriva da transacao para nao colapsar upsell com venda principal"
```

- [ ] **Step 8: Validar no Gerenciador de Eventos**

Depois de uma venda com upsell real, confirme na Meta que **dois** eventos `Purchase` aparecem, com `event_id` diferentes, e que a soma dos valores bate. Antes desta correção, o segundo era descartado silenciosamente.

**Risco: MÉDIO no Caso B, baixo no Caso A.** Ver Step 1. No Caso A a mudança só pode aumentar o número de conversões registradas (as que hoje somem), nunca duplicar.

---

## Task 7: I3 — alertas de falha e rotina de reprocessamento

**Files:**
- Modify: `server.js:268-273`
- Create: `scripts/reprocessa-capi.js`

**Interfaces:**
- Consumes: `buildPurchaseEvent` / `sendPurchase` do `capi.js` (Task 6). A idempotência do reenvio depende do `event_id` corrigido lá.

- [ ] **Step 1: Alerta grepável quando nenhum pixel aceita**

Em `server.js`, logo depois da linha 269 (`const algumOk = ...`):

```js
      if (!algumOk) {
        // prefixo fixo para alerta por match de string no Coolify/Discord
        console.error('CAPI_FALHOU', JSON.stringify({
          tx: txId, funil: funnel?.slug || null, resultados,
        }));
      }
```

- [ ] **Step 2: Escrever a rotina de reprocessamento**

Crie `scripts/reprocessa-capi.js`:

```js
// =====================================================================
//  reprocessa-capi.js — reenvia vendas pagas que nao chegaram a Meta.
//  Seguro para rodar repetido: o event_id e derivado da transacao, entao
//  a Meta deduplica reenvios (ver Task 6 — NAO rode antes dela).
//  Uso: node scripts/reprocessa-capi.js [--dry]
// =====================================================================
const { Pool } = require('pg');
const { sendPurchase } = require('../capi');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const dry = process.argv.includes('--dry');

async function main() {
  // 6 dias: a Meta rejeita eventos com mais de 7 dias
  const { rows: vendas } = await pool.query(`
    SELECT * FROM sales
    WHERE status='paid' AND capi_sent IS NOT TRUE AND funnel_id IS NOT NULL
      AND created_at > now() - interval '6 days'
    ORDER BY created_at`);

  console.log(`${vendas.length} venda(s) para reprocessar${dry ? ' (dry-run)' : ''}`);

  for (const v of vendas) {
    const { rows: fs } = await pool.query(
      `SELECT f.* FROM funnels f
       JOIN funnels o ON o.domain = f.domain
       WHERE o.id = $1 AND f.active`, [v.funnel_id]);
    if (!fs.length) { console.warn('sem funil ativo', v.transaction_id); continue; }

    const { rows: st } = await pool.query('SELECT * FROM store WHERE sck=$1', [v.sck]);
    const store = st[0] || null;
    const sale = {
      transaction_id: v.transaction_id,
      value: v.value,
      product_code: v.product_code,
      product_name: v.product_name,
      customer_email: v.customer_email,
      customer_phone: v.customer_phone,
    };

    if (dry) { console.log('enviaria', v.transaction_id, 'para', fs.map(f => f.pixel_id)); continue; }

    const resultados = [];
    for (const f of fs) {
      try {
        const r = await sendPurchase({ funnel: f, sale, store });
        resultados.push({ pixel: f.pixel_id, status: r.httpStatus, resp: r.response });
      } catch (err) {
        resultados.push({ pixel: f.pixel_id, status: 0, resp: String(err).slice(0, 200) });
      }
    }
    const ok = resultados.some(r => r.status === 200);
    await pool.query(
      `UPDATE sales SET capi_sent=$1, capi_response=$2 WHERE transaction_id=$3`,
      [ok, JSON.stringify(resultados), v.transaction_id]);
    console.log(v.transaction_id, ok ? 'OK' : 'FALHOU', JSON.stringify(resultados));
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Rodar em dry-run contra produção**

```bash
DATABASE_URL="<url de producao>" node scripts/reprocessa-capi.js --dry
```

Esperado: a lista das vendas que seriam reenviadas. Compare com o resultado da query (g) da Task 0. **Não rode sem `--dry` antes de confirmar que a Task 6 está no ar** — sem o `event_id` por transação, o reenvio pode gerar duplicata na Meta.

- [ ] **Step 4: Rodar de verdade**

```bash
DATABASE_URL="<url de producao>" node scripts/reprocessa-capi.js
```

Confirme no Gerenciador de Eventos que os eventos apareceram.

- [ ] **Step 5: Configurar o alerta**

No Coolify, configure notificação por match de string nos logs para `CAPI_FALHOU`. Se não houver esse recurso, agende o script em dry-run 1x/dia e revise a saída.

- [ ] **Step 6: Commit**

```bash
git add server.js scripts/reprocessa-capi.js
git commit -m "feat: alerta CAPI_FALHOU e rotina de reprocessamento"
```

**Risco: MÉDIO se rodado antes da Task 6.** Depois dela, o reenvio é idempotente por construção. O alerta em si é só um `console.error`.

---

## Task 8: I7 + I8 + M4 — guards contra falha silenciosa

Cada guard entra logando primeiro. Nenhum descarta requisição no primeiro deploy.

**Files:**
- Modify: `server.js:121, 200-202`

- [ ] **Step 1: Fallbacks para `transaction_id`**

Em `server.js:202`, substituir:

```js
    // A PayT varia a estrutura do payload (ver digSck). O transaction_id era
    // lido de um caminho unico. Se vier undefined: UNIQUE aceita multiplos
    // NULLs, entao o ON CONFLICT nunca dispara (venda duplicada por reenvio) e
    // o UPDATE de capi_sent casa zero linhas.
    const txId = p?.transaction_id ?? p?.transaction?.id ?? p?.id ?? null;
    if (!txId) {
      console.error('PAYT_SEM_TXID', JSON.stringify(p).slice(0, 500));
      return res.json({ ok: false, motivo: 'sem_transaction_id' });
    }
```

O `return` aqui é seguro: sem `transaction_id` a venda não pode ser gravada corretamente de jeito nenhum — hoje ela vira lixo no banco. A resposta segue 200, conforme a decisão 7.

- [ ] **Step 2: Alerta de comissão ausente**

Em `server.js`, logo depois da linha 200 (`const value = ...`):

```js
    // commission nao-array faz o .find e o fallback [0] falharem -> value 0.
    // Purchase com value 0 conta como conversao e puxa o ROAS aprendido pra baixo.
    if (paid && !(value > 0)) {
      console.error('VENDA_SEM_COMISSAO', JSON.stringify({
        tx: p?.transaction_id, commission: p?.commission,
      }));
    }
```

Note que isto **loga mas não bloqueia** o envio. Se depois de observar os logs você decidir que value 0 nunca deve ir para a Meta, adicione `&& value > 0` na condição da linha 244 — mas só com dado real justificando.

- [ ] **Step 3: Alerta de status desconhecido**

Em `server.js:121`, substituir por:

```js
    const statusBruto = p?.transaction?.payment_status || p?.status || null;
    const paid = statusBruto === 'paid';
    // se a PayT mudar o vocabulario de status, hoje as conversoes parariam de
    // ser enviadas sem nenhum sinal. Este log e o sinal.
    const CONHECIDOS = ['paid','waiting_payment','pending','refused','canceled','refunded','chargeback','expired'];
    if (statusBruto && !CONHECIDOS.includes(statusBruto)) {
      console.warn('PAYT_STATUS_DESCONHECIDO', statusBruto, p?.transaction_id);
    }
```

Ajuste `CONHECIDOS` com os valores reais que aparecem no seu banco:

```sql
SELECT status, count(*) FROM sales GROUP BY 1 ORDER BY 2 DESC;
```

**Atenção:** a linha 121 original também aceitava `p?.status === 'paid'`. A versão acima preserva isso (o `||` no `statusBruto`). Confira que `paid` continua verdadeiro nos mesmos casos.

- [ ] **Step 4: Verificar localmente**

```bash
node server.js &
curl -s -X POST "http://localhost:3000/webhook/payt?t=segredo123" -H 'Content-Type: application/json' \
  -d '{"status":"paid","product":{"code":"X"}}'
```

Esperado: log `PAYT_SEM_TXID` e resposta `{"ok":false,"motivo":"sem_transaction_id"}` — sem escrita no banco.

```bash
curl -s -X POST "http://localhost:3000/webhook/payt?t=segredo123" -H 'Content-Type: application/json' \
  -d '{"transaction_id":"T_SEMCOM","status":"paid","commission":{"amount":9700}}'
```

Esperado: log `VENDA_SEM_COMISSAO` (commission é objeto, não array — exatamente o caso que zera o value).

- [ ] **Step 5: Commit e deploy**

```bash
git add server.js
git commit -m "feat: guards e alertas para txid ausente, comissao zero e status desconhecido"
```

- [ ] **Step 6: (Opcional, quando decidir remover o log de PII)**

O `console.log('PAYT_WEBHOOK', ...)` da linha 118 é proposital e temporário. Quando remover, a versão redigida que continua útil:

```js
    console.log('PAYT', p?.transaction_id, sck, statusBruto, value);
```

Considere também retenção para `event_log.payload`, que grava `client_ip_address` e `client_user_agent` em claro:

```sql
DELETE FROM event_log WHERE created_at < now() - interval '90 days';
```

**Risco: baixo.** O único `return` novo é para payloads que hoje já produzem lixo no banco.

---

## Task 9: I9 — normalização de geo e telefone no formato da Meta

**Files:**
- Create: `geo.js`
- Modify: `capi.js` (uso em `buildPurchaseEvent`)
- Modify: `test/capi.test.js`

**Interfaces:**
- Produces: `normCidade(v)`, `normEstado(v)`, `normPais(v)`, `normTelefone(v)` — todas retornam string normalizada ou `undefined`.

- [ ] **Step 1: Confirmar o que está gravado**

Use o resultado da query (e) da Task 0. Se `state` já vier como `"SP"` e `country` como `"BR"`, as funções de estado/país só precisam do lowercase que já existe — mas mantenha-as, porque a fonte pode mudar.

- [ ] **Step 2: Escrever os testes que falham**

Adicione a `test/capi.test.js`:

```js
const { normCidade, normEstado, normPais, normTelefone } = require('../geo');

test('cidade: sem acento, sem espaco, sem pontuacao', () => {
  assert.strictEqual(normCidade('São Paulo'), 'saopaulo');
  assert.strictEqual(normCidade('Rio de Janeiro'), 'riodejaneiro');
  assert.strictEqual(normCidade("Santa Bárbara d'Oeste"), 'santabarbaradoeste');
});

test('estado: sigla de 2 letras minuscula', () => {
  assert.strictEqual(normEstado('SP'), 'sp');
  assert.strictEqual(normEstado('São Paulo'), 'sp');
  assert.strictEqual(normEstado('Minas Gerais'), 'mg');
});

test('pais: ISO de 2 letras minuscula', () => {
  assert.strictEqual(normPais('BR'), 'br');
  assert.strictEqual(normPais('Brasil'), 'br');
  assert.strictEqual(normPais('Brazil'), 'br');
});

test('telefone: E.164 com codigo do pais', () => {
  assert.strictEqual(normTelefone('(11) 98888-7777'), '5511988887777');
  assert.strictEqual(normTelefone('5511988887777'), '5511988887777');
  assert.strictEqual(normTelefone('+55 11 98888-7777'), '5511988887777');
});

test('normalizacao devolve undefined para vazio', () => {
  assert.strictEqual(normCidade(''), undefined);
  assert.strictEqual(normEstado(null), undefined);
  assert.strictEqual(normTelefone(undefined), undefined);
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
npm test
```

Esperado: FAIL com `Cannot find module '../geo'`.

- [ ] **Step 4: Implementar `geo.js`**

```js
// =====================================================================
//  geo.js — normalização no formato que a Meta exige ANTES do sha256.
//  Sem isto, ct/st/country sao enviados, contam como preenchidos no
//  relatorio de qualidade de correspondencia, e nao casam com nada.
// =====================================================================

const semAcento = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const UF = {
  acre:'ac', alagoas:'al', amapa:'ap', amazonas:'am', bahia:'ba', ceara:'ce',
  distritofederal:'df', espiritosanto:'es', goias:'go', maranhao:'ma',
  matogrosso:'mt', matogrossodosul:'ms', minasgerais:'mg', para:'pa',
  paraiba:'pb', parana:'pr', pernambuco:'pe', piaui:'pi', riodejaneiro:'rj',
  riograndedonorte:'rn', riograndedosul:'rs', rondonia:'ro', roraima:'rr',
  santacatarina:'sc', saopaulo:'sp', sergipe:'se', tocantins:'to',
};

// minusculas, sem acento, sem espaco e sem pontuacao
function normCidade(v) {
  if (!v) return undefined;
  const out = semAcento(v).toLowerCase().replace(/[^a-z]/g, '');
  return out || undefined;
}

// sigla de 2 letras minuscula; aceita nome por extenso
function normEstado(v) {
  if (!v) return undefined;
  const k = semAcento(v).toLowerCase().replace(/[^a-z]/g, '');
  if (k.length === 2) return k;
  return UF[k] || undefined;
}

// ISO-3166 alpha-2 minusculo
function normPais(v) {
  if (!v) return undefined;
  const k = semAcento(v).toLowerCase().replace(/[^a-z]/g, '');
  if (k.length === 2) return k;
  if (k === 'brasil' || k === 'brazil') return 'br';
  return undefined;
}

// E.164 sem '+': a Meta exige o codigo do pais. Numero BR de 10-11 digitos
// (DDD + numero) recebe o 55 na frente.
function normTelefone(v) {
  if (!v) return undefined;
  let d = String(v).replace(/\D/g, '');
  if (!d) return undefined;
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

module.exports = { normCidade, normEstado, normPais, normTelefone };
```

- [ ] **Step 5: Usar em `capi.js`**

No topo de `capi.js`, junto ao require do crypto:

```js
const { normCidade, normEstado, normPais, normTelefone } = require('./geo');
```

Em `buildPurchaseEvent`, no `user_data`, trocar as quatro linhas:

```js
    ph: hash(normTelefone(sale.customer_phone)),
    fn, ln,
    ct: hash(normCidade(store?.city)),
    st: hash(normEstado(store?.state)),
    country: hash(normPais(store?.country)),
```

A função `hashPhone` continua exportada (há teste nela) mas deixa de ser usada aqui.

- [ ] **Step 6: Rodar e confirmar que passa**

```bash
npm test
```

Esperado: 18 testes passando.

- [ ] **Step 7: Commit e deploy**

```bash
git add geo.js capi.js test/capi.test.js
git commit -m "fix: normaliza cidade/estado/pais/telefone no formato exigido pela Meta"
```

- [ ] **Step 8: Verificar o ganho**

Depois de ~3 dias, no Gerenciador de Eventos → seu pixel → "Qualidade da correspondência de eventos", confira a pontuação de `ct`, `st`, `country` e `ph`. Devem subir de ~0 para valores reais.

**Risco: baixo.** Se o hash mudar e nenhum melhorar, o pior caso é continuar sem casar — que é o estado atual.

---

## Task 10: I6 + M2 + M7 — CORS restrito, token fora da URL, rate limit

**Files:**
- Modify: `server.js:17-31` (CORS)
- Modify: `capi.js` (token no corpo)

- [ ] **Step 1: Logar as origens reais por 48h antes de restringir**

Antes de qualquer restrição, adicione ao middleware de CORS (`server.js:20`):

```js
  if (req.headers.origin) console.log('CORS_ORIGIN', req.headers.origin);
```

Deploy, espere 48h, e colete a lista real:

```
CORS_ORIGIN https://...
```

Isso evita cortar um domínio que você esqueceu de listar. **Se pular este passo, o risco desta task sobe de médio para alto.**

- [ ] **Step 2: Restringir o CORS à allowlist do banco**

Substituir o middleware `server.js:20-27` por:

```js
// Allowlist carregada dos funis. Recarrega a cada 5 min para pegar
// dominio novo sem redeploy.
let origensPermitidas = new Set();
async function recarregaOrigens() {
  try {
    const { rows } = await pool.query('SELECT domain FROM funnels WHERE active');
    const s = new Set();
    for (const r of rows) {
      if (!r.domain) continue;
      const bare = r.domain.replace(/^www\./, '');
      s.add('https://' + bare);
      s.add('https://www.' + bare);
      s.add('https://track.' + bare);
    }
    origensPermitidas = s;
  } catch (e) { console.error('CORS_RELOAD_ERRO', e); }
}
recarregaOrigens();
setInterval(recarregaOrigens, 5 * 60 * 1000).unref();

// CORS só na rota /collect (o webhook e o /health não são chamados por browser).
// Allow-Credentials foi removido: nenhum endpoint usa cookie ou sessão, e a
// combinação origin-refletido + credentials neutraliza a same-origin policy
// para qualquer endpoint de leitura que venha a existir aqui.
app.use('/collect', function (req, res, next) {
  const o = req.headers.origin;
  if (o && origensPermitidas.has(o)) {
    res.header('Access-Control-Allow-Origin', o);
  } else if (o) {
    console.warn('CORS_ORIGEM_NEGADA', o);
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
```

**Importante:** `sendBeacon` com `Content-Type: text/plain` é uma requisição "simples" e o browser a envia mesmo sem CORS de resposta — o dado continua chegando ao servidor mesmo para origem negada. O log `CORS_ORIGEM_NEGADA` é o que te avisa se sobrou algum domínio de fora.

- [ ] **Step 3: Mover o `access_token` para o corpo do POST**

Em `capi.js`, no `sendPurchase`:

```js
  const url = `${GRAPH}/${funnel.pixel_id}/events`;
  // token no corpo, nao na query: a URL aparece em qualquer log de erro
  // que a imprima e em traces de biblioteca HTTP.
  const body = { data: [event], access_token: funnel.capi_token };
```

- [ ] **Step 4: Verificar que a Meta aceita o token no corpo**

Faça uma venda de teste (ou rode o reprocessamento em uma transação conhecida) e confirme `httpStatus: 200` em `capi_response`. Se a Meta recusar, reverta só este passo — os demais são independentes.

- [ ] **Step 5: Rate limit no Traefik, não no código**

O Traefik já está na frente. No Coolify, adicione a label ao serviço:

```
traefik.http.middlewares.tracking-rl.ratelimit.average=30
traefik.http.middlewares.tracking-rl.ratelimit.burst=60
```

Zero código, zero dependência. Ajuste os números ao seu volume real de `/collect` (some os pageviews de checkout por minuto no pico e dobre).

- [ ] **Step 6: Commit e deploy**

```bash
git add server.js capi.js
git commit -m "fix: CORS por allowlist, token da Meta fora da URL"
```

**Risco: MÉDIO, reduzido a baixo pelo Step 1.** O modo de falha é um domínio legítimo ficar de fora da allowlist. Como o `sendBeacon` continua entregando mesmo sem o header de resposta, o impacto prático é pequeno, e o log `CORS_ORIGEM_NEGADA` mostra exatamente o que faltou.

---

## Task 11: I10 — build reproduzível e container sem root

**Files:**
- Create: `package-lock.json`
- Modify: `Dockerfile`
- Modify: `README.md`

- [ ] **Step 1: Descobrir as versões que rodam HOJE em produção**

No terminal do container, pelo Coolify:

```bash
npm ls --depth=0
```

Anote as versões exatas de `express` e `pg`. Gerar o lock sem isso pina o que o npm resolve hoje, que pode não ser o que está no ar.

- [ ] **Step 2: Gerar o lockfile com essas versões**

Localmente, com as versões anotadas (exemplo — use as suas):

```bash
npm install --package-lock-only express@4.19.2 pg@8.11.5
```

Confira que `package.json` não mudou de forma inesperada e que `package-lock.json` foi criado.

- [ ] **Step 3: Testar o build da imagem localmente**

Atualize o `Dockerfile`:

```dockerfile
FROM node:20-slim

WORKDIR /app

# npm ci exige o lockfile e instala exatamente as versoes pinadas.
# Com npm install + ranges ^, cada rebuild resolvia versoes diferentes de
# toda a arvore transitiva — deploy podia subir codigo nunca testado.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# a imagem node:20-slim ja traz o usuario 'node'. Sem isto o processo roda
# como root com o DATABASE_URL e alcance a todos os capi_token.
USER node

EXPOSE 3000

CMD ["node", "server.js"]
```

```bash
docker build -t tracking-teste .
docker run --rm -e DATABASE_URL="postgresql://postgres:test@host.docker.internal:55432/postgres" -p 3001:3000 tracking-teste
curl -s http://localhost:3001/health
```

Esperado: `{"ok":true}`.

- [ ] **Step 4: Documentar no README**

Substitua o `README.md` de uma linha por:

```markdown
# tracking

Servidor de eventos server-side (CAPI da Meta) — substitui GTM + Stape.
Multi-funil: cada domínio tem seu pixel; uma venda dispara só para o pixel do
domínio dela.

## Rotas
- `POST /collect` — a página do checkout grava fbp/fbc/UTMs no `store` (chave: `sck`)
- `POST /webhook/payt` — webhook de venda; resolve o funil e dispara o Purchase
- `GET /health`

## Variáveis de ambiente
| Nome | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | Postgres |
| `PAYT_WEBHOOK_TOKEN` | sim | Segredo do webhook. A URL cadastrada na PayT é `.../webhook/payt?t=<token>` |
| `PAYT_AUTH_ENFORCE` | não | `1` rejeita webhook sem token (401). Ausente = só loga. Kill switch. |
| `PORT` | não | Padrão 3000 |

## Schema
`schema.sql` tem o DDL das 6 tabelas. Para recriar do zero:
`psql "$DATABASE_URL" -f schema.sql`

## Testes
`npm test` (node:test, sem dependências). `./test/sql.test.sh` exige um Postgres
com o schema aplicado.

## Deploy
Coolify → Application → Dockerfile. Rollback = `git revert` + redeploy.

## Runbook
- **Vendas pararam de aparecer:** cheque `PAYT_AUTH_NEGADO` nos logs. Se houver
  entradas com `tx` preenchido, desligue `PAYT_AUTH_ENFORCE` e verifique a URL
  do webhook na PayT.
- **Venda no banco mas não na Meta:** `CAPI_FALHOU` nos logs.
  Reenvio: `node scripts/reprocessa-capi.js --dry` e depois sem `--dry`.
- **Venda atribuída ao pixel errado:** procure `FUNIL_NAO_RESOLVIDO`. A causa
  costuma ser `store.funnel_id` NULL, que joga a resolução no fallback por
  `product_code`.
```

- [ ] **Step 5: Commit e deploy**

```bash
git add package-lock.json Dockerfile README.md
git commit -m "chore: lockfile, npm ci, USER node e README com runbook"
```

Acompanhe este deploy de perto — é o único que muda como as dependências são instaladas. Se o container não subir, o `git revert` volta ao `npm install` anterior.

**Risco: MÉDIO, mitigado pelo Step 1.** Se as versões pinadas forem as mesmas que já rodam, o comportamento é idêntico.

---

## Pendências fora deste plano

Anotadas para decisão futura, não implementadas aqui:

- **M5** — `event_time` usa o instante do envio, não o do pagamento. Relevante para o reprocessamento (Task 7): eventos reenviados chegam com timestamp de hoje. Usar `paid_at` quando existir.
- **M6** — `paid_at` sem normalização de timezone. Verificar com a query (h) da Task 0 antes de decidir se há bug.
- **M9** — `fbc` reconstruível de `fbclid` (`fb.1.<timestamp_ms>.<fbclid>`) quando o cookie `_fbc` não existe. Ganho de match em Safari/bloqueadores.
- **M10** — índice em `clicks(sck, created_at DESC)`. Rodar `EXPLAIN` na query da linha 213 primeiro.
- **M3** — `resultados.push` antes do INSERT em `event_log` gera entrada duplicada quando o INSERT falha. Cosmético.
- **Reembolso/chargeback** — o status é atualizado em `sales` mas nada é comunicado à Meta.
- **Rotação de credenciais** — os tokens expostos em logs de chat durante o desenvolvimento continuam válidos.

---

## Ordem de execução recomendada

```
Task 0  (verificação)      -> sem deploy
Task 1  (auth shadow)      -> deploy, esperar 48h
Task 2  (resiliência)      -> deploy
Task 3  (ON CONFLICT)      -> deploy
Task 4  (store funnel_id)  -> deploy
Task 5  (auth enforce)     -> deploy + kill switch à mão
Task 6  (event_id)         -> VERIFICAR o Step 1 antes
Task 7  (alertas + reproc) -> depende da 6
Task 8  (guards)           -> deploy
Task 9  (geo/telefone)     -> deploy
Task 10 (CORS + token)     -> Step 1 loga 48h antes
Task 11 (build)            -> deploy acompanhado
```

As Tasks 2, 3, 4, 8 e 9 são independentes entre si e podem ser agrupadas num deploy só se você preferir menos janelas — mas em deploys separados o rollback é mais preciso.
