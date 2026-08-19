# Integração Digistore24 — Design

**Data:** 2026-08-19
**Estado base:** tag `pre-digistore24` (commit `e17ae58`)

## Problema

O tracking processa apenas vendas da PayT. É preciso receber vendas da Digistore24
também, em funis novos e isolados, sem colocar em risco o caminho da PayT — que
está em produção processando receita real.

## Contexto decidido com o dono

| Pergunta | Resposta |
|---|---|
| Escopo | Funis novos, exclusivos da Digistore24. Sem sobreposição com os 8 funis PayT existentes. |
| Receita (`value`) | `amount_vendor` — a parte do vendedor, após taxa da Digistore24 e divisão com afiliado. Análogo direto da comissão do produtor usada na PayT, mantendo o ROAS comparável entre plataformas. |
| Tipo de venda | Pagamento único, com order bump e upsell. Sem recorrência nem parcelamento. |
| Fluxo do comprador | Anúncio → página em domínio próprio → order form da Digistore24. O `/collect` continua funcionando; o `sck` viaja como `custom` na URL do checkout. |

## Abordagem escolhida

Endpoint separado, com o núcleo de processamento extraído e compartilhado.

Descartadas:

- **Código duplicado** — não toca o caminho da PayT, mas cria dois lugares para
  corrigir o mesmo defeito. Os três críticos corrigidos esta semana teriam
  precisado de correção dupla.
- **Handler único detectando a plataforma pelo payload** — mistura a autenticação
  das duas plataformas no caminho que processa venda real da PayT. Contraria o
  requisito de isolamento.

## Arquitetura

Hoje `server.js` tem ~420 linhas, das quais ~250 são o handler da PayT,
misturando autenticar, interpretar payload e processar venda. Só a terceira
responsabilidade é comum às plataformas.

| Arquivo | Responsabilidade | Testável sem banco |
|---|---|---|
| `payt.js` | `normalizarPayt(payload)` — payload PayT → formato interno. Puro. | sim |
| `digistore24.js` | `normalizarDigistore(payload)`, `assinaturaValida(params, passphrase)`. Puro. | sim |
| `vendas.js` | `processarVenda(venda)` — resolução de funil, lookup no `store`, upsert em `sales`, disparo CAPI, `event_log`, `capi_sent`. | não |
| `server.js` | Rotas, autenticação por plataforma, chamada ao `processarVenda`. | — |

### Formato interno

Contrato que os dois normalizadores produzem e que `processarVenda` consome:

```js
{
  origem,        // 'payt' | 'digistore24'
  txId,          // ja prefixado quando aplicavel
  sck, src,
  status, paid, teste,
  value, total, currency,
  productCode, productName,
  email, phone, nome,
  offerType, paymentMethod, paidAt, upsellFrom,
  city, state, country, ip,
  utmSource, utmCampaign, campaignId, adsetId, adId
}
```

## Modelo de dados

### Conflito entre plataformas

`sales.transaction_id` e `products.product_code` são `UNIQUE`. Um id da
Digistore24 que coincida com um da PayT faria o `ON CONFLICT DO UPDATE` **fundir
duas vendas diferentes em silêncio**.

**Solução: prefixo.** Vendas da Digistore24 entram como `ds24_<transaction_id>`;
produtos como `ds24_<product_id>`. `transaction_id` segue globalmente único, o
`ON CONFLICT (transaction_id)` não muda, e não há migração de constraint.

O `event_id` resolve por consequência: a regra é `'purchase_' + txId`, então vira
`purchase_ds24_ABCD1234` sem alterar `capi.js`.

**Alternativa descartada:** `UNIQUE (plataforma, transaction_id)`. É o modelo mais
correto e guardaria o id cru, mas exige trocar constraint e código no mesmo
deploy — se um sobe sem o outro, todo webhook quebra. O risco não compensa.

**Custo aceito:** o `transaction_id` no banco não é idêntico ao emitido pela
plataforma. Reconciliar contra export da Digistore24 exige remover o prefixo, e
uma consulta por id cru não encontra a venda. Se o id cru fizer falta, dá para
adicionar uma coluna guardando-o, sem migração.

### Coluna nova

```sql
ALTER TABLE sales ADD COLUMN IF NOT EXISTS plataforma TEXT NOT NULL DEFAULT 'payt';
```

Não participa de constraint alguma e o código antigo a ignora, então pode ser
criada antes de qualquer deploy. Serve ao dashboard para separar receita por
plataforma sem parsear prefixo de string.

### Inalterado

`store`, `clicks` e `event_log` são do lado do navegador ou genéricos. `funnels`
ganha linhas novas para os funis novos, sem coluna nova — nada no código
precisaria ler a plataforma do funil.

## Autenticação

A Digistore24 assina o IPN com **SHA-512 sobre todos os parâmetros ordenados**,
exceto o próprio `sha_sign`, usando uma passphrase definida na conta. É mais
forte que a chave estática da PayT.

- Passphrase em `DIGISTORE_IPN_PASSPHRASE`.
- Gate atrás de `DIGISTORE_AUTH_ENFORCE`, efetivo apenas quando igual à string
  `'1'`. Sobe desligado, logando `DIGISTORE_AUTH_NEGADO` sem bloquear — mesmo
  padrão de rollout já validado com `PAYT_AUTH_ENFORCE`.

**Algoritmo, confirmado no PDF oficial (página 20):**

1. Remover `sha_sign` do conjunto de parâmetros.
2. Ordenar os parâmetros restantes pelo nome, **sem diferenciar maiúsculas**.
3. Concatenar, sem separador e sem quebra de linha, `nome=valor` seguido da
   passphrase, para cada parâmetro.
4. `SHA-512` da string resultante, em hexadecimal maiúsculo.

Exemplo da documentação, com passphrase `xxxxx`:

```
buyer_email=claus@domain-xyz.dexxxxxorder_id=273732xxxxxpayment_id=PAYID-39-22012xxxxxtransaction_amount=17.00xxxxxtransaction_currency=USDxxxxx
```

Resultado esperado: `342770076245D14ED7DF4D2E5D82216D7EDF8F9E7969B5964C9C5DCB53E962BBECD545E90422B5329C69554FD8B1A7E7410736615FCA7FB5CBB3624CC016E4BC`

Esse par serve de vetor de teste em `test/digistore24.test.js`.

## Mapeamento Digistore24 → interno

Confirmado no PDF oficial de IPN (Digistore24, versão de 2018, `ipn_version` 1.2).

| Interno | Digistore24 | Observação |
|---|---|---|
| `txId` | `ds24_` + `transaction_id` | um `transaction_id` por pagamento; `order_id` agrupa a compra |
| `sck` | `custom` | parâmetro GET repassado pelo vendedor, `string(63)` |
| `value` | `amount_vendor` | a parte do vendedor |
| `total` | `amount_brutto` | valor pago pelo cliente |
| `currency` | `currency` | |
| `productCode` | `ds24_` + `product_id` | |
| `productName` | `product_name` | |
| `paid` | `transaction_type == 'payment'` | valores: `payment`, `refund`, `chargeback` |
| `teste` | `api_mode == 'test'` | não existe campo `is_test` no IPN |
| `email` | `buyer_email` | |
| `nome` | `address_first_name` + `address_last_name` | |
| `phone` | `address_phone_no` | |
| `city` / `state` / `country` | `address_city` / `address_state` / `address_country` | `country` é ISO-2 |
| `offerType` / `upsellFrom` | `order_id` + ordem da transação | uma compra tem uma venda inicial e até três upsells, todos com o mesmo `order_id` |

Campos presentes mas não usados neste escopo: `amount_netto` (bruto − VAT),
`amount_vat`, `amount_provider` (taxa Digistore24), `amount_payout` (total a
repartir), `amount_affiliate`, `pay_sequence_no` (0 em pagamento único),
`billing_status` (`completed` em pagamento único), `order_item_id`, `buyer_id`.

**Restrição do `custom`:** `string(63)`. Os `sck` no formato `idx_...` têm ~22
caracteres e cabem. Os `v3_...` herdados da PayT passam de 63 e seriam truncados
— como os funis Digistore24 são novos e geramos o `sck` no `/collect`, basta
manter o formato curto. Truncamento silencioso quebraria a atribuição sem erro
visível.

## Contrato de resposta e reentrega

A PayT aceita qualquer 200 — e o webhook responde 200 mesmo em erro interno, de
propósito, para evitar retry storm. **A Digistore24 é diferente.**

Confirmado no PDF: uma chamada IPN só é considerada bem-sucedida se o servidor da
Digistore24 receber um token específico no corpo da resposta. **Qual token
exatamente não pôde ser extraído do PDF** — a palavra se perdeu na extração de
texto. A convenção da plataforma é `OK`, mas isso será verificado empiricamente,
não assumido: dispara-se um IPN de teste respondendo `OK` e confere-se em
`Settings → IPN → Reports` se ficou registrado como sucesso. O log da Digistore24
lista cada chamada como bem ou malsucedida, então o experimento é conclusivo.

A rota nova responde texto puro, não `res.json({ok:true})`.

**Reentrega, confirmado no PDF:** falhando, a Digistore24 tenta **no mínimo 20
vezes ao longo de 10 dias** — a primeira após 3 minutos, com o intervalo subindo
até 24 horas depois da décima tentativa.

Isso torna a idempotência mais crítica aqui do que na PayT, que não reenvia. Duas
defesas já existem e passam a valer para a Digistore24 sem código novo:

- o upsert em `sales` é por `transaction_id`, então reentrega atualiza a linha em
  vez de duplicar;
- o `event_id` é derivado do `txId`, então a Meta deduplica o Purchase reenviado.

A correção do `event_id` feita esta semana é o que torna essa integração segura
contra reentrega. Sem ela, 20 tentativas poderiam virar 20 conversões.

## Tratamento de erro

| Situação | Comportamento |
|---|---|
| Assinatura inválida | `DIGISTORE_AUTH_NEGADO`; 401 apenas se `DIGISTORE_AUTH_ENFORCE=1` |
| `api_mode == 'test'` | grava em `sales`, não dispara Purchase |
| `custom` ausente | sem `sck`, resolução cai no fallback por `product_code` |
| Status desconhecido | `DIGISTORE_STATUS_DESCONHECIDO` |
| Falha no envio à Meta | reusa `CAPI_FALHOU` e `scripts/reprocessa-capi.js` |

O script de reprocessamento lê de `sales` sem saber de plataforma, então cobre as
duas sem alteração — desde que o gate de `send_to_meta` continue casando, o que
funciona com os códigos prefixados.

Como o `custom` é a única fonte de `sck` na Digistore24, cadastrar os produtos em
`products` como `ds24_<product_id>` desde o início importa mais aqui do que na
PayT: é a única rede de segurança quando o click id não volta.

## Fases

Duas fases, deploys separados.

**Fase 1 — extração, sem mudança de comportamento.** Cria `payt.js` e `vendas.js`
a partir do handler atual. Nenhum código da Digistore24 existe ainda.

*Critério de aceite:* para o mesmo payload da PayT, o que entra em `sales` antes e
depois é idêntico campo a campo. Os 14 testes atuais continuam passando, mais
testes novos de `normalizarPayt` com payloads reais dos logs. Se algo divergir, a
fase é revertida e a Fase 2 passa a usar caminho duplicado.

**Fase 2 — Digistore24.** Cria `digistore24.js` e a rota `POST
/webhook/digistore24`. A essa altura o caminho da PayT já está estável na forma
nova, e o código novo toca arquivo novo mais uma rota nova.

## Verificação

- `test/payt.test.js` — `normalizarPayt` com payloads reais tirados dos logs
- `test/digistore24.test.js` — `normalizarDigistore` e `assinaturaValida`, esta
  com vetor conhecido (passphrase + params → assinatura esperada)
- Os 14 testes existentes seguem passando

**Sem cobertura automatizada:** `processarVenda`, porque toca banco e não há
Postgres no ambiente de desenvolvimento. Coberto por revisão e teste manual
pós-deploy — mesma limitação de todo o projeto.

## Fora de escopo

- Recorrência e parcelamento (produtos são de pagamento único)
- Vendas Digistore24 em funis que já vendem pela PayT
- Tráfego que vá direto ao checkout sem passar por domínio próprio
- Coluna com o `transaction_id` cru — adicionar só se fizer falta
- Alterações no `/collect`; a única mudança do lado da página é o botão de compra
  passar `?custom=<sck>` ao order form

## Rollback

- **Código:** tag `pre-digistore24` (`e17ae58`)
- **Banco:** backup Coolify de 2026-08-19 20:22 (918 KB, formato custom —
  restaurar com `pg_restore`)
- A coluna `plataforma` é removível com `DROP COLUMN`; o prefixo `ds24_` não
  altera nenhuma linha existente
