# Handoff: Production Access Required

The following steps require direct access to the production database and cannot be completed locally without Docker/psql.

## Step 1: Dump Production Schema

Run this command on a machine with Postgres access, using the production `DATABASE_URL`:

```bash
pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > schema.sql
```

Verify the output contains these 6 tables: `funnels`, `sales`, `clicks`, `store`, `event_log`, `products`.

Save the result as `schema.sql` in the repo root.

## Step 2: Verify Production Assumptions

Run these queries against production and document the results — the inline comments reference which tasks depend on each result:

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

If **(f)** returns rows, Task 6 should move to higher priority.
If **(h)** shows `paid_at` 3h ahead of the real time, Task 6 (M6 findings) is confirmed.

## Step 6: Docker Postgres Setup

After obtaining `schema.sql` from Step 1, set up a local test database:

```bash
docker run -d --name tracking-test -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16
sleep 5
psql "postgresql://postgres:test@localhost:55432/postgres" -f schema.sql
```

A later task will add `test/sql.test.sh`, which will need a Postgres instance with this schema applied.

---

**This handoff must be completed by the repo owner before Tasks 2–8 can run their full test suites.**

---

## Task 3: Corrigir vendas já corrompidas (rodar só depois do deploy)

`server.js` agora tem um `ON CONFLICT` completo em `sales` (ver commit da Task 3), mas isso não conserta as linhas que já foram gravadas com `value = 0` e sem atribuição antes da correção. Estas queries devem ser rodadas manualmente em produção, na ordem abaixo — **o `SELECT` precisa ser inspecionado antes de rodar qualquer `UPDATE`**.

Identifica vendas pagas com `value=0` que têm um clique atribuível:

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

## Task 4: Recuperar `funnel_id` em linhas antigas de `store` (rodar só depois do deploy)

`server.js` agora tem `funnel_id` no `ON CONFLICT` da tabela `store` (ver commit da Task 4), mas linhas que nasceram com `funnel_id = NULL` porque o domínio era desconhecido no primeiro `/collect` permanecem NULL. A query abaixo recupera esses valores onde há um clique com funil atribuído na mesma `sck`.

**Risco: baixo.** Só preenche NULLs; não toca em valores já presentes.

Primeiro execute como `SELECT` para ver quantas linhas seriam afetadas:

```sql
SELECT COUNT(*) FROM store st
WHERE st.funnel_id IS NULL
AND EXISTS (SELECT 1 FROM clicks c WHERE c.sck = st.sck AND c.funnel_id IS NOT NULL);
```

Depois execute o `UPDATE`:

```sql
UPDATE store st SET funnel_id = c.funnel_id
FROM (SELECT DISTINCT ON (sck) sck, funnel_id FROM clicks
      WHERE funnel_id IS NOT NULL ORDER BY sck, created_at DESC) c
WHERE c.sck = st.sck AND st.funnel_id IS NULL;
```

## Task 5: Ligar o enforce de autenticação (rodar só depois do deploy)

`server.js` agora tem o gate de autenticação do `/webhook/payt` (ver commit da Task 5), mas ele nasce **desligado**: só bloqueia quando `PAYT_AUTH_ENFORCE=1` estiver definido no ambiente. Enquanto isso, ele continua só logando `PAYT_AUTH_NEGADO` em caso de falha, sem retornar 401. Os passos abaixo são do repo owner, com acesso ao Coolify e ao painel da PayT — não foram (e não podem ser) executados neste ambiente de desenvolvimento local.

**Risco: ALTO, mitigado.** Este é o único ponto do plano onde um erro de configuração para de gravar vendas. Siga a ordem exata abaixo.

### 1. Deploy com o enforce desligado

Esta branch é implantada de uma vez só — o log incondicional `PAYT_AUTH` da Task 1 não existe mais no código; foi substituído pelo bloco de gate desta task, que só loga `PAYT_AUTH_NEGADO`, e só em caso de falha. **A instrução da Task 1 de observar `PAYT_AUTH` com `ok:true` por 48h está superada: esse log não existe mais assim que este código sobe.** Use o critério da seção 2 abaixo.

Suba o código desta task com `PAYT_AUTH_ENFORCE` **ausente ou `0`**. O gate está no ar mas continua só logando — com o enforce desligado, toda requisição cujo token não bate ainda passa, só que agora emitindo `PAYT_AUTH_NEGADO`. Confirme que as vendas continuam entrando normalmente antes de ir para o próximo passo.

### 2. Critério de liberação (antes de ligar o enforce)

Com o gate no ar e o enforce desligado, observe os logs de produção (Coolify) por pelo menos 48h cobrindo um volume real de vendas. Procure `PAYT_AUTH_NEGADO`:

- `tx: null` com IPs desconhecidos é varredura da internet — esperado, não bloqueia a liberação.
- `tx` preenchido significa uma venda real chegando sem token válido — exatamente a falha de configuração que o enforce, uma vez ligado, transformaria em vendas perdidas.

**Critério para ligar o enforce:** zero entradas `PAYT_AUTH_NEGADO` com `tx` preenchido no período observado. Se aparecer alguma, **pare** e investigue a origem antes de continuar — não ligue o enforce.

### 3. Ligar o enforce

No Coolify, defina `PAYT_AUTH_ENFORCE=1` e reinicie a aplicação (só restart, sem rebuild — o kill switch é a mesma variável, de volta para `0` ou ausente).

### 4. Validar imediatamente com uma venda real

Faça uma compra de teste real na PayT (valor mínimo) e confirme, em até 5 minutos:

```sql
SELECT transaction_id, status, value, funnel_id, capi_sent FROM sales ORDER BY created_at DESC LIMIT 3;
```

Esperado: a venda de teste aparece com `capi_sent = true`.

### 5. Rollback

Se a venda **não** aparecer dentro de 5 minutos, desligue o enforce agora (`PAYT_AUTH_ENFORCE=0` + restart) e volte para o modo shadow — sinal de que a URL configurada na PayT não está mandando o token correto.

### 6. Monitorar por 24h

Procure `PAYT_AUTH_NEGADO` nos logs.

- `tx: null` com IPs desconhecidos: varredura da internet — exatamente o que o gate existe para barrar. Não requer ação.
- `tx` preenchido: uma venda real está sendo rejeitada. Desligue o enforce (`PAYT_AUTH_ENFORCE=0` + restart) e investigue antes de religar.

## Task 7: Alerta CAPI_FALHOU e reprocessamento (rodar só depois do deploy)

`server.js` agora loga `CAPI_FALHOU` (prefixo fixo, greppável) quando nenhum pixel aceitou o Purchase de uma venda paga. `scripts/reprocessa-capi.js` reenvia vendas pagas com `capi_sent IS NOT TRUE` chamando `sendPurchase` de `capi.js` — o mesmo caminho usado pelo webhook, então herda o `event_id = 'purchase_' + transaction_id` da Task 6.

**Risco: MÉDIO se rodado antes da Task 6 estar no ar.** Sem o `event_id` por transação (commit `5d3c837`), o reenvio pode gerar evento duplicado na Meta em vez de deduplicar. Confirme que esse commit está em produção antes de rodar o script pela primeira vez.

### 1. Rodar em dry-run contra produção

```bash
DATABASE_URL="<url de producao>" node scripts/reprocessa-capi.js --dry
```

Esperado: uma linha `N venda(s) para reprocessar (dry-run)` seguida de uma linha `enviaria <transaction_id> para [<pixel_id>, ...]` por venda. Compare a contagem com a query (g) da Task 0 (seção "Backlog", abaixo). Não gera nenhuma chamada de rede nem grava nada no banco.

### 2. Rodar de verdade

Só depois de confirmar o dry-run e o deploy da Task 6:

```bash
DATABASE_URL="<url de producao>" node scripts/reprocessa-capi.js
```

Cada venda reenviada grava `capi_sent`/`capi_response` em `sales` (mesmo formato que o webhook grava) e imprime `<transaction_id> OK ...` ou `<transaction_id> FALHOU ...`. Confirme no Gerenciador de Eventos da Meta que os eventos apareceram.

Janela: o script só pega vendas com `created_at` nos últimos 6 dias — a Meta rejeita eventos com mais de 7 dias, a margem de 1 dia é para o tempo de execução/agendamento.

### 3. Alerta no Coolify

Configure notificação por match de string nos logs do serviço para `CAPI_FALHOU` (prefixo fixo em `server.js`, sempre no início da linha). Se o Coolify não tiver esse recurso, agende `node scripts/reprocessa-capi.js --dry` 1x/dia (cron) e revise a saída manualmente.

### 4. Query de backlog (para conferência manual a qualquer momento)

```sql
SELECT count(*) FROM sales WHERE status='paid' AND capi_sent IS NOT TRUE;
```

Mesma query (g) do Step 2 desta handoff — deve tender a zero conforme o reprocessamento roda periodicamente.
