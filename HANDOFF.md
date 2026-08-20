# Handoff: Production Access Required

## Checklist pré-deploy (fazer NESTA ORDEM, antes de subir a branch)

1. **Conferir versões instaladas.** No terminal do container rodando em produção (Coolify): `npm ls --depth=0`. Se `express`/`pg` vierem diferentes de `4.22.2`/`8.23.0`, regenere o lock e commit antes de dar deploy — comando exato na seção do Task 11, mais abaixo.
2. **Gerar e configurar o token do webhook.** Isto está ausente do handoff até agora, e sem ele o critério de liberação do Task 5 nunca pode ser cumprido — o gate fica no ar mas o token nunca é validado de verdade. Gere com:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Configure o valor gerado como `PAYT_WEBHOOK_TOKEN` no Coolify, e troque a URL do webhook cadastrada no painel da PayT. O código aceita o token de duas formas: header `x-payt-token` (preferido — não vaza em log de acesso de proxy) ou `?t=<TOKEN>` na query string.
3. **Conferir os produtos cadastrados.**
   ```sql
   SELECT product_code, offer_type, send_to_meta, active FROM products ORDER BY funnel_slug;
   ```
   Confirme que todo upsell está marcado corretamente — a partir do `event_id` por transação (Task 6), upsells deixam de colidir com a venda principal e passam a ser enviados à Meta individualmente, então um `send_to_meta` errado aqui agora tem efeito imediato.
4. **Rodar as queries (a)–(i)** já documentadas abaixo (Step 2) e gerar o `schema.sql` (Step 1).

Feito isso: suba a branch com **`PAYT_AUTH_ENFORCE` e `CORS_ALLOWLIST_ENFORCE` ambos ausentes/desligados**. Os dois entram em modo shadow (só logam) até os critérios de liberação das seções Task 5 e Task 10 serem cumpridos.

---

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

**As Tasks numeradas abaixo já estão implementadas e commitadas** (não são trabalho pendente de código) — o que falta é executá-las em produção, na ordem em que aparecem, seguindo o checklist pré-deploy no topo deste arquivo.

---

## Task 2: Verificar `trust proxy` (rodar só depois do deploy)

`server.js` trocou `b.ip || req.ip` por `req.ip || b.ip` (ver commit da Task 2), fazendo o IP derivado do proxy imediato ser a única fonte de `client_ip_address`. Isso é correto se o Coolify/Traefik é a única camada na frente do serviço. Se houver uma segunda camada (ex.: Cloudflare) na frente do Traefik, `trust proxy 1` devolve o IP da borda (Cloudflare) em vez do IP do visitante — degradando silenciosamente `client_ip_address` na Meta, exatamente o defeito que a mudança pretendia corrigir, só que invertido.

Confirme com tráfego real após o deploy:

```sql
SELECT ip_override, count(*) FROM store WHERE created_at > now() - interval '1 hour'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

Esperado: IPs residenciais variados, não `172.x` (rede interna do Docker) e não um punhado de IPs repetidos (sinal de estar pegando a borda de um CDN/proxy em vez do visitante).

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

## Task 6: Verificar dedupe de upsell (rodar só depois do deploy)

`capi.js` agora deriva `event_id` da transação (`purchase_<transaction_id>`) em vez do `sck` (ver commit `5d3c837`). Depois de uma venda real com upsell na mesma sessão, confirme no Gerenciador de Eventos da Meta que aparecem **dois** eventos `Purchase` com `event_id`s distintos (um por transação).

**Aviso: o volume de `Purchase` na Meta vai subir depois deste deploy.** Antes, a venda principal e o upsell da mesma sessão compartilhavam `event_id = sck`, e a Meta descartava o segundo evento como duplicata. Esse é o comportamento pretendido pela correção — mais eventos reais chegando —, mas para uma operação que otimiza campanhas nesse sinal é uma mudança de baseline a se antecipar (não é anomalia, não precisa de investigação).

## Task 7: Alerta CAPI_FALHOU e reprocessamento (rodar só depois do deploy)

`server.js` agora loga `CAPI_FALHOU` (prefixo fixo, greppável) quando nenhum pixel aceitou o Purchase de uma venda paga. `scripts/reprocessa-capi.js` reenvia vendas pagas com `capi_sent IS NOT TRUE` chamando `sendPurchase` de `capi.js` — o mesmo caminho usado pelo webhook, então herda o `event_id = 'purchase_' + transaction_id` da Task 6. O script respeita a mesma regra de `send_to_meta` do webhook: produto cadastrado com `send_to_meta=false` (upsell/backend) nunca é reenviado, mesmo estando com `capi_sent IS NOT TRUE`.

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

Contagem bruta (mesma query (g) do Step 2 desta handoff — inclui vendas de produto `send_to_meta=false`, que o script NUNCA reenvia de propósito):

```sql
SELECT count(*) FROM sales WHERE status='paid' AND capi_sent IS NOT TRUE;
```

Contagem exata do que o script vai processar (bate com o dry-run — exclui produto com `send_to_meta=false`, mesma regra do webhook em `server.js`):

```sql
SELECT count(*) FROM sales s
WHERE s.status='paid' AND s.capi_sent IS NOT TRUE AND s.funnel_id IS NOT NULL
  AND s.created_at > now() - interval '6 days'
  AND NOT EXISTS (
    SELECT 1 FROM products pr
    JOIN funnels f ON f.slug = pr.funnel_slug
    WHERE pr.product_code = s.product_code AND pr.active AND f.active
      AND pr.send_to_meta = false
  );
```

Mesma query (g) do Step 2 desta handoff — deve tender a zero conforme o reprocessamento roda periodicamente.

## Task 8: Guards contra falha silenciosa (I7 + I8 + M4)

`server.js` agora loga três casos que antes falhavam calados: `transaction_id` ausente (`PAYT_SEM_TXID`, com early return e `{ok:false, motivo:'sem_transaction_id'}` — a venda não é gravável de jeito nenhum sem chave, hoje vira lixo no banco), comissão zerada num pagamento `paid` (`VENDA_SEM_COMISSAO`, só loga, não bloqueia o envio à Meta) e status de pagamento fora do vocabulário conhecido (`PAYT_STATUS_DESCONHECIDO`, só loga). Nenhum dos três muda o comportamento de envio hoje — todos foram implementados como "loga primeiro".

**Risco: baixo.** O único `return` novo é para payloads que hoje já produzem lixo no banco (linha coberta pelo teste local abaixo).

### 1. Reconciliar `CONHECIDOS`

A lista `CONHECIDOS` em `server.js` (paid, waiting_payment, pending, refused, canceled, refunded, chargeback, expired) foi copiada da brief sem confirmar contra o banco real, porque este ambiente de desenvolvimento não tem acesso a produção. Rode e ajuste a lista com os valores reais antes de considerar o alerta silencioso confiável:

```sql
SELECT status, count(*) FROM sales GROUP BY 1 ORDER BY 2 DESC;
```

Um status desconhecido só gera `console.warn`, nunca muda o `paid` calculado nem o que é gravado — ajustar a lista depois é seguro, sem deploy urgente.

### 2. Teste local: DB indisponível impediu validar a resposta exata dos guards via curl

Os dois curls do Step 4 da brief foram rodados de verdade, mas **nenhum dos dois chegou aos guards novos**: a resolução de funil (fallback por `product.code` e o fallback 3 incondicional — `SELECT * FROM funnels WHERE active`, código de tasks anteriores, não tocado aqui) roda *antes* do guard de `txId` e sempre faz pelo menos um `SELECT`. Sem Postgres neste ambiente, ambos os requests morreram em `ECONNREFUSED` capturado pelo catch externo (`{"ok":false}` genérico, HTTP 200), antes de alcançar `PAYT_SEM_TXID` ou `VENDA_SEM_COMISSAO`. Ver `task-8-report.md` para os logs completos. A lógica dos três guards foi verificada isoladamente (script à parte, não commitado) reproduzindo as mesmas expressões usadas em `server.js` para os mesmos payloads — todos os casos bateram, incluindo o caso de divergência do `paid` (`transaction.payment_status` preenchido com valor diferente de `'paid'` e `status === 'paid'`). Rode os dois curls do Step 4 de novo assim que houver um Postgres acessível, para confirmar a resposta exata em runtime.

### 3. Opções para quando decidir remover o log de PII (Step 6 da brief, não feito nesta task)

`console.log('PAYT_WEBHOOK', ...)` (linha ~145) continua propositalmente ligado — não foi tocado. Quando decidir remover, a versão redigida sugerida na brief:

```js
console.log('PAYT', p?.transaction_id, sck, statusBruto, value);
```

`event_log.payload` grava `client_ip_address` e `client_user_agent` em claro. Retenção sugerida (não rodada — decisão do owner):

```sql
DELETE FROM event_log WHERE created_at < now() - interval '90 days';
```

## Task 9: Normalização de geo e telefone no formato da Meta (I9)

`geo.js` (novo) exporta `normCidade`, `normEstado`, `normPais`, `normTelefone`. `capi.js` agora hasheia `ct`/`st`/`country`/`ph` já normalizados (sem acento/espaço/pontuação para cidade, sigla de 2 letras para estado, ISO alpha-2 para país, E.164 com DDI 55 para telefone BR de 10-11 dígitos) em vez de só `trim().toLowerCase()`. Antes disso os três campos de geo eram enviados, contavam como preenchidos no relatório de qualidade de correspondência da Meta e nunca casavam com nada.

**Step 1 da brief não pôde ser confirmado — sem acesso a produção.** Rode a query (e) do Step 2 desta handoff (`SELECT state, country, count(*) FROM store GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;`) para ver o que `store.state`/`store.country` realmente contêm hoje. Isso é informativo, não bloqueante: `normEstado`/`normPais` tratam os dois formatos — sigla de 2 letras passa direto, nome por extenso mapeia pelo dicionário `UF` (só os 26 estados + DF, sem sinônimos além de `brasil`/`brazil` para país). Se `state` tiver algo fora do mapa (abreviação de outro país, erro de digitação, etc.), `normEstado` devolve `undefined`, `hash(undefined)` também devolve `undefined` (`capi.js`, linha `if (value === undefined || value === null || value === '') return undefined;`), e `clean()` remove a chave do `user_data` em vez de mandar um hash que nunca vai casar — estritamente melhor que o comportamento anterior.

**Risco: baixo**, conforme a brief — se o hash mudar e não melhorar nada, o pior caso é continuar sem casar, que já é o estado atual.

**Step 8 da brief (conferir a pontuação de qualidade de correspondência no Gerenciador de Eventos da Meta) é ação do operador, não pode ser feito neste ambiente.** Depois do deploy, aguarde ~3 dias e confira, no pixel de cada funil, Gerenciador de Eventos → "Qualidade da correspondência de eventos" — os campos `ct`, `st`, `country` e `ph` devem sair de ~0 para valores reais.

## Task 10: CORS por allowlist, token da Meta fora da URL, rate limit (I6 + M2 + M7)

`server.js` agora carrega uma allowlist de origens a partir de `funnels.domain` (recarregada a cada 5 min, `.unref()` para não segurar o processo vivo) e aplica CORS **só na rota `/collect`** — o webhook e o `/health` não são chamados por browser. `Access-Control-Allow-Credentials: true` viaja junto com `Access-Control-Allow-Origin` no mesmo condicional: foi restaurado porque removê-lo era a única mudança visível ao browser não controlada pelo kill switch. Se a página de checkout chama `/collect` com `credentials: 'include'` e content-type JSON, o browser exige um preflight; sem o header `Access-Control-Allow-Credentials`, o preflight é rejeitado silenciosamente e o POST nunca sai — uma perda que não gera log no servidor e que o kill switch não poderia desfazer. `capi.js` agora manda `access_token` no corpo do POST em vez da query string (a URL some de qualquer log/trace que a imprima).

**A brief original pedia log-e-espera-48h antes de restringir (Step 1), assumindo deploy tarefa-por-tarefa. Esta branch sobe tudo de uma vez, então esse intervalo não existe.** Em vez disso, o CORS usa o mesmo esquema de kill switch da Task 5 (`PAYT_AUTH_ENFORCE`):

- `CORS_ORIGIN <origem>` é logado **sempre**, para toda requisição em `/collect` com header `Origin` — é essa janela de observação, ligada desde o primeiro deploy, que substitui as 48h da brief.
- A restrição de verdade só entra com `CORS_ALLOWLIST_ENFORCE=1` no ambiente. Com a variável ausente (estado inicial), uma origem fora da allowlist ainda é refletida em `Access-Control-Allow-Origin` — comportamento de hoje preservado — mas gera `CORS_ORIGEM_NEGADA <origem>`, o sinal de quem seria bloqueado. Com `CORS_ALLOWLIST_ENFORCE=1`, essa mesma origem para de receber o header (sem refletir), mantendo só o log.
- `sendBeacon` com `Content-Type: text/plain` é uma requisição "simples" — o browser a envia mesmo sem CORS de resposta favorável, então o dado continua chegando ao servidor mesmo com uma origem negada. `CORS_ORIGEM_NEGADA` é o alerta, não um bloqueio de dados.

**Risco: MÉDIO, reduzido a baixo pelo log incondicional.** O modo de falha é um domínio de funil legítimo (ou uma variação de subdomínio não coberta pelos três padrões — `https://dominio`, `https://www.dominio`, `https://track.dominio`) ficar de fora da allowlist quando `CORS_ALLOWLIST_ENFORCE=1` for ligado.

### 1. Deploy com o enforce desligado

Suba esta branch com `CORS_ALLOWLIST_ENFORCE` **ausente**. O comportamento de resposta ao browser sem `CORS_ALLOWLIST_ENFORCE` não muda (origem continua refletida junto com `Access-Control-Allow-Credentials: true`). Com `CORS_ALLOWLIST_ENFORCE=1`, apenas origens allowlisted recebem ambos os headers — estritamente mais seguro que o código antigo, que refletia qualquer origem com credentials.

### 2. Critério de liberação (antes de ligar o enforce)

Observe os logs de produção por alguns dias cobrindo tráfego real de todos os funis ativos. Procure `CORS_ORIGEM_NEGADA`:

- Origem de scanner/bot aleatório: esperado, não bloqueia a liberação.
- Origem que é claramente um domínio (ou subdomínio) de funil real: falta na allowlist. Confirme se `funnels.domain` está cadastrado e ativo para esse funil, ou se o padrão de subdomínio usado (ex.: `checkout.dominio` em vez de `track.dominio`) não é um dos três gerados por `recarregaOrigens`. Ajuste o dado em `funnels` (não o código) sempre que possível — o dado errado/ausente é o caso comum.

**Critério para ligar o enforce:** zero entradas `CORS_ORIGEM_NEGADA` com origem de funil real no período observado.

### 3. Ligar o enforce

No Coolify, defina `CORS_ALLOWLIST_ENFORCE=1` e reinicie (restart, sem rebuild).

### 4. Rollback

Remova `CORS_ALLOWLIST_ENFORCE` (ou defina qualquer valor diferente de `'1'`) e reinicie. Volta a refletir qualquer origem, exatamente como no passo 1 — sem perder o log `CORS_ORIGEM_NEGADA`.

### 5. Validar que a Meta aceita `access_token` no corpo (Step 4 da brief — não pôde ser feito neste ambiente)

Este passo exige um pixel e um `capi_token` reais; não há como simular sem produção. Depois do deploy, faça uma venda de teste (ou rode `node scripts/reprocessa-capi.js` numa transação conhecida) e confirme `httpStatus: 200` em `sales.capi_response`. **Se a Meta recusar o token no corpo, reverta só este passo** (`capi.js`, volta o token para a query string) — a mudança de CORS e a de rate limit são independentes e não precisam ser revertidas junto.

### 6. Rate limit no Traefik (Step 5 da brief — documentação apenas, sem código)

O Traefik já está na frente do serviço. No Coolify, adicione as labels ao serviço:

```
traefik.http.middlewares.tracking-rl.ratelimit.average=30
traefik.http.middlewares.tracking-rl.ratelimit.burst=60
```

Zero código, zero dependência nova. Ajuste os números ao volume real de `/collect`: some os pageviews de checkout por minuto no pico entre todos os funis e dobre a margem.

## Task 11: Build reproduzível e container sem root (I10)

O `Dockerfile` rodava `npm install` sem lockfile versionado — nunca existiu um neste repo. Com ranges `^` em `express` e `pg`, cada rebuild reresolvia toda a árvore transitiva: um redeploy de sexta-feira podia subir dependências nunca testadas, e é o vetor clássico de supply-chain num container que segura o `DATABASE_URL` e alcança o `capi_token` de todos os funis. `npm ci --omit=dev` agora exige o lockfile e instala exatamente o que ele pina. Separadamente, o processo rodava como root sem motivo — `node:20-slim` já traz o usuário `node`; o Dockerfile agora troca para ele antes do `CMD`.

**O Step 1 da brief (`npm ls --depth=0` no container do Coolify, para pinar as versões que já rodam em produção) não pôde ser executado neste ambiente — não há acesso ao container.** O `package-lock.json` deste commit foi gerado com `npm install --package-lock-only` a partir do `package.json` atual, sem tocar nas dependências declaradas (`express: ^4.19.2`, `pg: ^8.11.5`). Isso pina o que o npm resolve **hoje**, que pode não ser o que está no ar há meses.

**Versões pinadas neste lockfile:**
- `express` → `4.22.2`
- `pg` → `8.23.0`

### Antes de dar deploy nesta branch

1. No terminal do container em produção (Coolify):
   ```bash
   npm ls --depth=0
   ```
2. Compare as versões de `express` e `pg` ali com as pinadas acima.
3. **Se forem iguais:** nada a fazer, o comportamento do `npm ci` é idêntico ao `npm install` que já rodava.
4. **Se forem diferentes:** regenere o lock pinando as versões de produção antes de dar deploy:
   ```bash
   npm install --package-lock-only express@X pg@Y
   ```
   (troque `X` e `Y` pelas versões vistas no `npm ls --depth=0` do container), commit o `package-lock.json` resultante, e só então faça deploy.

### Smoke test do owner antes do deploy (Step 3 da brief — não pôde ser rodado neste ambiente, sem docker)

```bash
docker build -t tracking-teste .
docker run --rm -e DATABASE_URL="postgresql://postgres:test@host.docker.internal:55432/postgres" -p 3001:3000 tracking-teste
curl -s http://localhost:3001/health
```
Esperado: `{"ok":true}`.

### Prova local de que o lock está em sincronia com o `package.json` (sem rede, sem docker)

```bash
npm ci --dry-run
```
Retornou `up to date` sem nenhuma resolução pendente — o `npm ci` do Dockerfile tem o que precisa.

**Este é o único deploy da branch que muda como as dependências são instaladas — acompanhe de perto.** Se o container não subir, `git revert` deste commit volta ao `npm install` anterior (sem lockfile, sem `USER node`).

## Digistore24 — coluna `plataforma`

`vendas.js` agora grava `plataforma` (`venda.origem`) em cada `INSERT` de `sales` — hoje sempre `'payt'`, e passará a valer `'digistore24'` quando o normalizador da Digistore24 entrar (task futura). A coluna é puramente aditiva, sem constraint, e o código anterior a este commit ignorava qualquer coluna extra — não há janela de incompatibilidade entre rodar o `ALTER TABLE` e subir o deploy.

**Rodar antes do deploy**, num ambiente com acesso à produção (este ambiente de desenvolvimento não tem):

```bash
node scripts/q.js "ALTER TABLE sales ADD COLUMN IF NOT EXISTS plataforma TEXT NOT NULL DEFAULT 'payt'"
```

Confira:

```bash
node scripts/q.js "SELECT plataforma, count(*) FROM sales GROUP BY 1"
```

Esperado: uma linha, `payt`, com o total de vendas.

### Rollback

```sql
ALTER TABLE sales DROP COLUMN plataforma
```

## Digistore24 — configuração

### Cadastro de funis e produtos

**Step 1: Cadastrar os funis**

Para cada funil novo, com o domínio de tracking, o pixel e o token da conta de anúncios:

```bash
node scripts/q.js "INSERT INTO funnels (slug, domain, pixel_id, capi_token, currency, active, funil, sigla) VALUES ('NOVO-SLUG','www.NOVODOMINIO','PIXEL_ID','CAPI_TOKEN','BRL',true,'NOME DO FUNIL','SIGLA')"
```

Confira:

```bash
node scripts/q.js "SELECT id, slug, sigla, domain, pixel_id, capi_token IS NOT NULL AS tem_token, active FROM funnels ORDER BY id"
```

**Step 2: Cadastrar os produtos com o prefixo**

O `product_id` da Digistore24 entra prefixado com `ds24_`, igual ao que o normalizador produz:

```bash
node scripts/q.js "INSERT INTO products (product_code, funnel_slug, offer_type, send_to_meta, active) VALUES ('ds24_122343','NOVO-SLUG','principal',true,true)"
```

Marque cada upsell com `send_to_meta=false`, como nos funis da PayT. Isso importa mais aqui: o `custom` é a única fonte de `sck` na Digistore24, então o `product_code` é a única rede de segurança quando o click id não volta.

Confira:

```bash
node scripts/q.js "SELECT product_code, funnel_slug, offer_type, send_to_meta FROM products WHERE product_code LIKE 'ds24_%' ORDER BY funnel_slug"
```

**Limite de 63 caracteres no `custom`:** os `sck` no formato `idx_...` têm ~22 e cabem; um formato mais longo seria truncado em silêncio e quebraria a atribuição sem erro visível.

**Step 4: Verificar a primeira venda real**

```bash
node scripts/q.js "SELECT transaction_id, plataforma, status, value, funnel_id, capi_sent FROM sales WHERE plataforma='digistore24' ORDER BY created_at DESC LIMIT 5"
```

Esperado numa venda paga: `plataforma='digistore24'`, `value` igual ao `amount_vendor` do relatório da Digistore24, `funnel_id` preenchido, `capi_sent=true`.

Se `funnel_id` vier nulo, o `custom` não chegou — confira o link do botão. Se `capi_sent` for falso, procure `CAPI_FALHOU` nos logs.

### Implantação e autenticação

1. Definir `DIGISTORE_IPN_PASSPHRASE` no Coolify com a passphrase da conta Digistore24 (`Settings → IPN`).
2. Cadastrar a URL do IPN na Digistore24: `https://track.<dominio>/webhook/digistore24`.
3. Subir com `DIGISTORE_AUTH_ENFORCE` **ausente**.
4. **Confirmar o token de resposta:** disparar um IPN de teste e conferir em `Settings → IPN → Reports` se a chamada aparece como sucesso. Se aparecer como falha, o corpo esperado não é `OK` — ajustar `res.send()` conforme o que o log indicar.
5. Observar `DIGISTORE_AUTH_NEGADO`. Zero entradas com `tx` preenchido por ~48h cobrindo vendas reais → ligar `DIGISTORE_AUTH_ENFORCE=1` + restart.
6. Rollback: `DIGISTORE_AUTH_ENFORCE=0` + restart.

## Pendências conhecidas

Achados menores da revisão final, deferidos de propósito. `.superpowers/` (onde ficava o histórico completo de decisões) não vai para o repo — este é o registro que sobrevive ao clone.

- **Allowlist de CORS cobre só `https://` + `www.` + `track.` de cada domínio** — não `http://`, não portas, não um subdomínio de checkout arbitrário. **Resolva isto antes de ligar `CORS_ALLOWLIST_ENFORCE`**, usando os logs de `CORS_ORIGEM_NEGADA` para achar o que falta.
- `sales` não tem `customer_name` — eventos reprocessados chegam à Meta sem `fn`/`ln`, com qualidade de correspondência pior que a de um evento normal do webhook.
- `VENDA_SEM_COMISSAO` loga `p.commission` cru — revise antes de configurar retenção de log longa (o log `PAYT_WEBHOOK` grava o payload inteiro de qualquer forma, e é o problema de PII maior dos dois).
- O script de reprocessamento não grava em `event_log` — reenvios não têm a paridade de auditoria que o webhook tem.
- `normPais` reconhece `br`/`brasil`/`brazil` e passa através de qualquer código de 2 letras (ISO alpha-2); `normTelefone` prefixa `55` em qualquer número de 10–11 dígitos. Adequado para uma operação só-Brasil; os dois descartam ou forçam em vez de mandar um hash que nunca vai casar.
