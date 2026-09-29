# Qualidade de correspondência na Meta — Design

**Data:** 2026-09-29
**Repositórios:** tracking (núcleo) e dashboard (header e painel)

## Problema

O Purchase que vai para a CAPI hoje leva e-mail, telefone, nome, `fbp`, `fbc`, IP e user
agent — o núcleo do que a Meta usa para casar a conversão com uma pessoa. Mas quatro dos
doze campos previstos nunca são preenchidos, o IC só existe no navegador, e o pixel da
página não carrega nenhum identificador que ligue o visitante à compra que o servidor
manda depois. A nota de *Qualidade da correspondência de eventos* (EMQ) fica abaixo do
que o mesmo dado permitiria, e é essa nota que determina quanto a Meta consegue aprender
sobre quem compra.

## O que a documentação da Meta pede

Conferido em `conversions-api/parameters/customer-information-parameters`,
`conversions-api/best-practices`, `deduplicate-pixel-and-server-events` e
`parameters/fbp-and-fbc`:

- Os parâmetros de maior impacto na correspondência: `em`, `ph`, `external_id`, `fbc`,
  `fbp`, `client_ip_address`, `client_user_agent`. Quanto mais deles por evento, melhor.
- `external_id` é o identificador **próprio** do anunciante (cookie, id de usuário);
  hash recomendado. É o que liga eventos da mesma pessoa entre navegador e servidor.
- Quando o cookie `_fbc` não existe mas o `fbclid` veio na URL, o servidor deve montar
  `fbc = fb.1.<timestamp ms do clique>.<fbclid>` — o `fbclid` cru não é aceito.
- Setup redundante: os mesmos eventos pelo pixel **e** pela CAPI, deduplicados por
  `event_name` + `event_id` iguais, dentro de 48h. `InitiateCheckout` é citado
  nominalmente.
- Normalização antes do hash: e-mail minúsculo sem espaços; telefone só dígitos com
  código do país; cidade minúscula sem espaço/pontuação; estado 2 letras; país ISO
  3166-1 alpha-2 minúsculo.
- `action_source`, `event_source_url` e `client_user_agent` são obrigatórios em evento
  de site.

## O que muda

### A. Purchase com todos os campos que já temos

Em `capi.js`, `buildPurchaseEvent` passa a receber também o `click` (a linha de `clicks`
que `vendas.js` já carrega) e a venda com `sck`, geo e IP:

| campo | hoje | depois |
|---|---|---|
| `ct`, `st`, `country` | `store.*` — nunca preenchido | `store.*` **ou** `venda.city/state/country` — a Digistore24 manda os três no IPN |
| `external_id` | `store.external_id` — nunca preenchido | `hash(sck)` — o `sck` é o id próprio do visitante, estável do primeiro clique à compra |
| `fbc` | `store.fbc` | `store.fbc` **ou** `fb.1.<created_at do clique em ms>.<clicks.fbclid>` |
| `client_ip_address` | `store.ip_override` | `store.ip_override` **ou** `venda.ip` (a PayT manda o IP do comprador) |

O resto do evento não muda: `event_id = 'purchase_' + transaction_id`, `action_source`,
`event_source_url`, `custom_data`. **Nada sobre quais vendas vão para a Meta muda.**

`normPais` passa a entender os países do tráfego real além do Brasil (`US`, `USA`,
`United States`, `Estados Unidos`, `CA`, `GB`, `UK`, `AU`, `PT`, `ES`, `MX`, `DE`, `FR`,
`IT`, e o 2-letras de qualquer um). Desconhecido continua `undefined` — a Meta diz que
campo errado é pior que campo ausente.

PayT não manda endereço; vendas dela ficam sem geo. Geo-IP exigiria serviço externo e
está fora.

### B. InitiateCheckout também pela CAPI

O header já dispara `fbq('track','InitiateCheckout', {}, { eventID: sck })` no clique do
botão. O servidor passa a mandar o mesmo evento pela CAPI a partir do `/collect`, com:

- `event_name: 'InitiateCheckout'`, `event_id: sck` — igual ao do pixel, para a Meta
  deduplicar;
- `user_data`: `fbp`, `fbc` (com o mesmo fallback pelo `fbclid`), `client_ip_address`,
  `client_user_agent`, `external_id = hash(sck)`;
- `event_source_url: page_location`, `action_source: 'website'`;
- para **todos os pixels ativos do domínio**, como o Purchase (multi-pixel).

**Sem bloquear o `/collect`.** O envio acontece depois de `res.json({ ok: true })`, em
`setImmediate`, com `try/catch` próprio. Falha na Meta vira log (`CAPI_IC_FALHOU`), nunca
erro para o navegador e nunca atraso no clique. Cada envio grava em `event_log`
(`event_name = 'InitiateCheckout'`, `event_id = sck`, `source = 'server'`), a mesma
tabela e as mesmas colunas do Purchase.

Kill switch: `CAPI_IC_DESLIGADO=1` desliga o envio sem deploy. Nasce **ligado** — é o
que a Meta recomenda e o que este trabalho existe para entregar; o switch é para
emergência, não para rollout.

O header repete o IC a cada clique (com trava de 1,5s); repetições chegam com o mesmo
`event_id` e a Meta descarta, como já descarta as do pixel.

### C. `external_id` no pixel do navegador

O header passa a inicializar o pixel com matching avançado:
`fbq('init', '<pixel>', { external_id: sck })`. É o único dado de pessoa que a página tem,
e é o que liga o PageView e o IC do navegador ao Purchase do servidor, que manda o mesmo
`hash(sck)`.

Isso exige que o `sck` exista **antes** do `fbq('init')`. Hoje ele nasce no segundo bloco
de script. O template ganha um primeiro bloco curto que resolve o `sck` (cookie `index` →
`localStorage` → novo `idx_…`, a mesma lógica de hoje) e o expõe em `window.__sck`; o
bloco de captura passa a ler dali. O regex do cookie e o gerador de `idx_` não mudam.

É uma mudança **deliberada do template para todos os funis**: os fixtures de fidelidade
(`tests/fixtures/header/*.html`) são atualizados junto, e continuam travando o template
byte a byte a partir daí. O header precisa ser **recolado** em todas as páginas de todos
os domínios para o `external_id` valer — o runbook diz isso.

E-mail e telefone no pixel do navegador ficam de fora: a presell e a VSL não os têm; só
o checkout, que é da PayT/Digistore24.

### D. Eventos de teste

Variável opcional `META_TEST_EVENT_CODE`. Quando definida, todo evento sai com
`test_event_code`, e aparece em tempo real em *Gerenciador de Eventos › Testar eventos*
com os campos de `user_data` que a Meta reconheceu. É como o operador confere A, B e C
sem esperar relatório. Em produção fica **vazia** — com ela definida, os eventos não
contam para otimização.

### E. Painel no dashboard: o que está chegando na Meta

O `event_log` já guarda o payload completo de cada evento enviado (com os valores em
hash). O card do domínio em `/admin/tracking` ganha a aba **Meta**, lendo os últimos 7
dias:

| | Purchase | InitiateCheckout |
|---|---|---|
| eventos enviados / aceitos (HTTP 200) | n / n | n / n |
| `em`, `ph`, `fn`, `ln` | % com o campo | — |
| `external_id`, `fbp`, `fbc` | % | % |
| `client_ip_address`, `client_user_agent` | % | % |
| `ct`, `st`, `country` | % | — |

É a leitura interna do que o Gerenciador de Eventos mostra como EMQ: se `fbc` está em
40% dos Purchase, o problema é captura na página; se `country` está em 0% num funil
PayT, é o esperado. Leitura só, pela `query` do tracking; sem escrita, sem schema novo.

## Fora de escopo

- Geo-IP para vendas da PayT.
- `db`, `ge`, `zp`: nenhuma plataforma manda.
- E-mail/telefone no pixel do navegador.
- Reprocessar Purchases antigos com os campos novos: o `reprocessa-capi.js` continua
  cobrindo só `capi_sent IS NOT TRUE`; reenviar o que já foi aceito é duplicar.
- ViewContent, Lead, AddToCart: o funil não tem esses momentos.

## Verificação

Tracking, `node --test`, sem rede e sem banco:

- `fbc` vem do `store` quando existe; senão é montado do `fbclid` com o timestamp do
  clique; senão ausente. `fbclid` cru nunca sai.
- `ct`/`st`/`country` caem para a venda quando o `store` não tem; normalizados; `US`,
  `United States`, `Estados Unidos` → `us`; desconhecido → ausente.
- `external_id` é `hash(sck)`; ausente sem `sck`.
- IP cai para `venda.ip`.
- `buildInitiateCheckoutEvent`: `event_id = sck`, os cinco campos de `user_data`,
  `event_source_url`, sem `custom_data`.
- Purchase sem os dados novos gera exatamente o evento de hoje (não-regressão).
- `test_event_code` presente só quando a variável existe.
- `/collect` responde antes de qualquer chamada à Meta e responde 200 mesmo com a Meta
  fora (teste com `fetch` falso que rejeita).

Dashboard, `npm run check`:

- template novo byte a byte com os fixtures novos; `fbq('init')` com `external_id`; o
  `sck` resolvido antes do `init`; blocos `<script>` válidos (`node --check`), 3 sem
  Google e 4 com.
- `coberturaUserData(rows)` pura: percentuais por campo e por evento, `http 200` contado,
  payload inválido ignorado sem quebrar.

Em produção, antes e depois: a nota EMQ do Purchase no Gerenciador de Eventos, e a aba
*Testar eventos* com `META_TEST_EVENT_CODE` por uma hora.
