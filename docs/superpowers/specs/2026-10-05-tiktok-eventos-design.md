# TikTok Ads — eventos (pixel + Events API) — Design

**Data:** 2026-10-05
**Repositórios:** tracking (núcleo) e dashboard (cadastro, header, cobertura)
**Projeto 2 (gasto e campanhas, Marketing API):** spec própria, noutro chat.

## Problema

Os funis passam a rodar TikTok Ads. Hoje o tracking só conhece a Meta (pixel + CAPI) e o
Google (tag + CSV). Sem pixel e sem Events API da TikTok, a TikTok não vê nem clique nem
venda — otimiza às cegas — e o dashboard não sabe de qual anúncio veio a venda.

## O que a TikTok oferece (conferido na documentação)

- **Pixel** `ttq`: `ttq.load(pixel)`, `ttq.page()`, `ttq.identify({...})` (matching avançado;
  o pixel hasheia no navegador), `ttq.track('InitiateCheckout', {...}, { event_id })`.
- **Events API v1.3**: `POST https://business-api.tiktok.com/open_api/v1.3/event/track/`,
  header `Access-Token`, corpo `{ event_source: "web", event_source_id: <pixel>,
  test_event_code?, data: [{ event, event_time (s), event_id, user: { email, phone,
  external_id, ttclid, ttp, ip, user_agent }, properties: { value, currency, contents,
  content_type, order_id }, page: { url } }] }`. `email`/`phone`/`external_id` em SHA-256
  (e-mail minúsculo sem espaços; telefone E.164 com `+`).
- **Token**: gerado em *Events Manager › pixel › Settings › Generate Access Token*. Um por
  pixel, longa duração, **sem app e sem OAuth** — igual ao token CAPI da Meta.
- **Dedupe**: mesmo `event_source_id` + `event` + `event_id` em 48h → fica o primeiro.
- **Eventos**: `InitiateCheckout`, `CompletePayment` (compra). Sem `Purchase`.
- **Identificadores de clique**: `ttclid` na URL de entrada; cookie `_ttp` do pixel. A
  documentação põe o `ttclid` como o de maior peso na correspondência.
- **Teste**: `test_event_code`, aba *Test Events* do pixel.

## A. Onde o pixel mora: `tiktok_pixels`

Tabela nova no banco do tracking: `id`, `domain`, `pixel_code`, `access_token`, `active`,
`created_at`. **Vários por domínio**, como os pixels da Meta.

Por que não em `funnels`: cada linha de `funnels` é um pixel da Meta com token CAPI, e
tanto a resolução de funil quanto o loop da CAPI varrem essa tabela. Linha TikTok ali
seria tratada como pixel da Meta. O domínio é o elo: um pixel TikTok vale para todos os
funis do seu domínio, como o Google.

O dashboard escreve na tabela nova pelo mesmo `writeQuery` (papel `dashboard_rw`), o que
exige um `GRANT` novo — passo do operador. O token nunca sai do banco para a tela.

## B. Captura no header

Quando o domínio tem pixel TikTok cadastrado, o header ganha, entre o bloco da Meta e o
do Google:

1. o carregador `ttq`, `ttq.identify({ external_id: window.__sck })`, um `ttq.load` por
   pixel, `ttq.page()`;
2. captura de `ttclid` da URL com o mesmo padrão das UTMs (cookie, propagação presell →
   VSL), e leitura do cookie `_ttp` como já lê `_fbp`;
3. no clique do botão: `ttq.track('InitiateCheckout', {}, { event_id: sck })`, e `ttclid` +
   `ttp` no payload do `/collect`.

Sem pixel TikTok no domínio, o header sai idêntico ao de hoje — a inserção é por âncora,
como a do Google. Recolar o header é passo do operador.

## C. O que o servidor manda

| evento | quando | `user` | `properties` |
|---|---|---|---|
| `InitiateCheckout` | `/collect`, depois de responder, `event_id = sck` | `ttclid`, `ttp`, `ip`, `user_agent`, `external_id` | — |
| `CompletePayment` | webhook, venda paga, `event_id = 'purchase_' + transaction_id` | + `email`, `phone` | `value`, `currency`, `contents: [{ content_id, content_name, quantity: 1, price }]`, `content_type: 'product'`, `order_id` |

Para **todos os pixels TikTok ativos do domínio** do funil resolvido, um evento por pixel —
o mesmo multi-pixel da Meta. `event_id` igual ao do pixel (`sck`) deduplica o IC. O
`external_id` é `hash(sck)`, o mesmo que vai para a Meta: a mesma pessoa, a mesma chave,
nas duas plataformas.

**Quais vendas:** `products.send_to_tiktok`, nascendo com o valor de `send_to_meta`; produto
não cadastrado **não** vai (lado seguro, como no Google); `enviarMeta: false` do postback de
afiliado vale para a TikTok também (comissão de terceiro não otimiza campanha nossa).

**Falha não derruba nada:** a TikTok é enviada depois da Meta, cada pixel com seu
`try/catch`; falha vira log `TIKTOK_FALHOU` e linha no `event_log` com status 0. Kill switch
`TIKTOK_EVENTS_DESLIGADO=1`. `TIKTOK_TEST_EVENT_CODE` opcional, mesma regra da Meta: só
para a aba *Test Events*, por minutos, e fora de produção.

## D. O registro e a cobertura

`event_log` ganha a coluna `plataforma` (`meta` | `tiktok`, default `meta`), porque
`InitiateCheckout` tem o mesmo nome nas duas. Todo `INSERT` passa a nomear a coluna.

A aba **Meta** do card vira **Plataformas**: dois blocos lado a lado com a mesma leitura
(enviados / aceitos / % por campo), um por plataforma, com os campos de cada uma — na
TikTok: `email`, `phone`, `external_id`, `ttclid`, `ttp`, `ip`, `user_agent`.

## E. Atribuição no dashboard

- Fonte de tráfego `TikTok` com `utm_source = TT` (o `cleanSource` deixa passar).
- Modelo de URL para os anúncios, com as macros da TikTok — que, ao contrário do Google,
  trazem o **nome**:
  `?utm_source=TT&utm_campaign=__CAMPAIGN_NAME__|__CAMPAIGN_ID__&utm_medium=__AID_NAME__|__AID__&utm_content=__CID_NAME__|__CID__&utm_term=__PLACEMENT__`
  Cai direto no padrão `nome|id` que o tracking já lê, e a tela de Campanhas do Projeto 2
  já nasce com nome.
- Vendas e receita por canal vêm do tracking, como para a Meta. Gasto é Projeto 2.

## F. Dashboard — cadastro

No card do domínio em `/admin/tracking`, aba **TikTok**: lista dos pixels (código, ativo),
formulário "código do pixel + token" (token `type="password"`, nunca exibido depois), botão
desativar. `assertGestor`. Sem DELETE (desativar é `active = false`).

## Operador

Antes do deploy (banco do tracking, `node scripts/q.js`):
`CREATE TABLE tiktok_pixels`, `ALTER TABLE clicks ADD ttclid, ttp`, `ALTER TABLE products
ADD send_to_tiktok` (+ `UPDATE … = COALESCE(send_to_meta, true)`), `ALTER TABLE event_log
ADD plataforma`, `GRANT SELECT, INSERT, UPDATE ON tiktok_pixels` e a sequence para
`dashboard_rw`. Depois: deploy tracking → dashboard → cadastrar pixel e token → recolar o
header → `TT` nas fontes → modelo de URL nos anúncios → *Test Events* por minutos.

## Fora de escopo

- Marketing API, gasto, campanhas (Projeto 2).
- `ViewContent`, `AddToCart`, página de obrigado.
- Reembolso/estorno na TikTok.
- Reprocesso de vendas antigas para a TikTok.

## Verificação

Tracking, `node --test`, sem rede e sem banco: construtor de `CompletePayment` (hash de
e-mail/telefone com `+`, `external_id`, `ttclid`/`ttp`/ip/ua do clique, `properties` com
valor/moeda/`order_id`), construtor de IC (`event_id = sck`, sem `properties`), envio com
`Access-Token` e `test_event_code` só quando definido, `vendas.js` mandando para os pixels
TikTok do domínio só quando `send_to_tiktok`, `/collect` gravando `ttclid`/`ttp` e
disparando o IC TikTok depois da resposta, `event_log` com `plataforma`.

Dashboard, `npm run check` + `next build`: header com e sem TikTok (sem = byte a byte com o
fixture), blocos válidos, captura e IC; cobertura por plataforma; cadastro validado.
