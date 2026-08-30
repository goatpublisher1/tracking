# Postback de afiliado da Digistore24 — Design

**Data:** 2026-08-30

## Problema

Vendemos como afiliado um produto de terceiro (parceria AdonisVitality) no funil de
backend do SWH. A comissão dessas vendas não aparece em lugar nenhum: o dashboard só
enxerga o que está na tabela `sales`, e nada grava essas vendas lá.

Cadastrar o `product_code` do produto no dashboard não resolve, e é importante entender
por quê antes de mexer: `/webhook/digistore24` recebe o **IPN de venda**, que é
configurado pelo *vendor* dentro do produto dele. Num produto de terceiro não temos essa
tela. O cadastro ficaria parado, esperando um webhook que nunca vem.

## O canal que existe

A Digistore24 tem um **Postback S2S de afiliado**, configurado na nossa conta e disparado
nas vendas dos nossos links, seja qual for o produto. É um canal diferente do IPN de
vendor em três aspectos que importam:

| | IPN de venda | Postback S2S de afiliado |
|---|---|---|
| Quem configura | o vendor, no produto | nós, na nossa conta |
| Transporte | POST com corpo | **GET com query string que nós montamos** |
| Autenticação | assinatura SHA-512 sobre o payload | **nenhuma** — nem assinatura, nem header |
| Nossa receita | `amount_vendor` | `amount_affiliate_abs`, a comissão |

O terceiro ponto é o que faz este trabalho ser um canal novo em vez de um ajuste: o
`normalizarDigistore` atual lê o campo errado para receita, e a rota atual espera um POST
assinado.

O segundo ponto é o que faz ser barato: nós escolhemos os parâmetros da URL, então não
dependemos do formato deles.

## A. Rota

`GET /webhook/digistore24-afiliado`.

Responde `200` em qualquer desfecho de processamento, como as outras rotas de webhook — a
alternativa é a Digistore24 reenviar. A exceção é o token: token ausente ou errado devolve
`401`, que dispara o e-mail de notificação de erro já configurado na conexão. Um postback
que não autentica é configuração errada, e tem que ser visível.

## B. Autenticação

Token na query string, comparado com `DIGISTORE_AFILIADO_TOKEN` por `tokenValido` —
o mesmo comparador em tempo constante que a PayT usa.

Não há alternativa: o postback não assina o payload e não permite header. É o mesmo
desenho que a UTMify usa na conexão que já existe nesta conta.

**Risco aceito, registrado:** token em query string aparece em log de acesso do proxy. O
estrago máximo de um vazamento é alguém gravar venda falsa na nossa tabela `sales`; não há
dinheiro nem dado de cliente do outro lado. Se um dia incomodar, a saída é rotacionar o
token, que é uma variável de ambiente.

Diferente das outras plataformas, este gate **não** nasce atrás de um `_ENFORCE`. O motivo
do gate escalonado nas outras foi não derrubar um fluxo de vendas reais que já estava em
produção; aqui não há fluxo nenhum ainda, e o primeiro postback já chega no formato final.

## C. Normalização

Arquivo novo `digistore24-afiliado.js`, puro, ao lado de `digistore24.js`. Reaproveita
`traduzirStatus` — o vocabulário é o mesmo (`payment`, `refund`, `chargeback`).

| campo da venda | vem de |
|---|---|
| `value` | `commission` (`{amount_affiliate_abs}`) — é a nossa receita |
| `total` | `amountGross` (`{amount_brutto_abs}`) — o que o cliente pagou |
| `txId` | `ds24a_` + `transactionId` |
| `productCode` | `ds24a_` + `productId` |
| `productName` | `productName` |
| `status` / `paid` | `status` (`{billing_status}`) e `transactionType`, pela tabela existente |
| `teste` | `isTest` igual a `"1"` |
| `offerType` | fixo `'backend'` |
| `funnelSlug` | parâmetro fixo `funil` da URL |
| `enviarMeta` | fixo `false` |
| `origem` | `'digistore24_afiliado'` |

**Prefixo `ds24a_`, não `ds24_`.** Um mesmo `transaction_id` pode existir nos dois canais
se um dia formos vendor e afiliado do mesmo produto. Prefixos distintos mantêm as duas
linhas separadas em `sales.transaction_id`, que é a chave de deduplicação.

`sck`, `src`, `email`, `phone`, `ip` ficam nulos: o postback não traz nenhum deles, e
inventar valor a partir de campo parecido é pior que o nulo honesto.

## D. Duas mudanças no núcleo compartilhado

`processarVenda` é usado pelas duas plataformas atuais. As duas mudanças abaixo são
aditivas — nenhum campo novo presente significa exatamente o comportamento de hoje.

**1. `funnelSlug` como primeiro passo da resolução de funil.** Sem `sck` e sem produto
cadastrado, nada resolveria o funil, e a venda gravaria com `funnel_id` nulo — invisível no
dashboard, que recorta por funil. Como a conexão de postback já é dedicada a uma parceria,
um parâmetro fixo na URL é determinístico e não depende de cadastro.

**2. `enviarMeta: false` respeitado.** Hoje `sendToMeta` nasce `true` e só vira `false` se
o produto estiver cadastrado com `send_to_meta = false` (`vendas.js:22`). Um produto de
terceiro nunca estará cadastrado, então sem esta mudança a comissão iria para a Meta e
poluiria a otimização das nossas campanhas — dinheiro real, silenciosamente.

## E. Dashboard

Nenhuma mudança. A query de receita soma `sales.value` filtrando por funil e período. Com
`funnel_id` do SWH e `status = 'paid'`, a comissão entra na receita do SWH e, por
`offer_type = 'backend'`, na linha de upsell/backend — separada da venda principal, sem
schema novo e sem tela nova.

## Fora de escopo

- **UTMs do postback.** A Digistore24 manda `{utm_source}` e companhia, mas `processarVenda`
  lê UTM da tabela `clicks`, que só existe com `sck`. Essas vendas vão aparecer sem origem
  na quebra por canal. Consumir as UTMs do postback seria um segundo caminho de gravação,
  e o pedido é receita.
- **CAPI e otimização de campanha** para vendas de afiliado. Deliberado, ver D.2.
- **Tela de cadastro de parceria de afiliado no dashboard.** Uma conexão, um funil, uma
  variável de ambiente. Enquanto for uma parceria, configuração é mais barata que interface.
- **O `LOG TEMPORARIO` em `server.js:247`,** que despeja o IPN inteiro no log e pode conter
  e-mail de comprador. Problema real, anterior a este trabalho, e de outra rota.

## Verificação

Testes em `test/`, com `node --test`, sem rede e sem banco — como o resto do repositório:

- `commission` vira `value`, `amountGross` vira `total` (o inverso é o erro que apaga a receita)
- prefixo `ds24a_` em `txId` e `productCode`
- `isTest=1` marca teste
- tradução de `payment`, `refund` e `chargeback`
- postback sem `transactionId` não quebra
- token errado não passa, token certo passa
- `processarVenda` com `funnelSlug` resolve o funil sem `sck`
- `processarVenda` com `enviarMeta: false` não chama a Meta
- venda da PayT sem os campos novos continua idêntica — a garantia de que o núcleo
  compartilhado não regrediu
