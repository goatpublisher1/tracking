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
| `CORS_ALLOWLIST_ENFORCE` | não | `1` restringe `/collect` à allowlist de `funnels.domain`. Ausente = origem ainda refletida (permissivo), mas loga `CORS_ORIGEM_NEGADA`. Kill switch. |
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
- **Origem de checkout bloqueada no `/collect`:** procure `CORS_ORIGEM_NEGADA`.
  Confirme se o domínio está cadastrado e ativo em `funnels.domain`; se
  `CORS_ALLOWLIST_ENFORCE=1` estiver causando falso positivo, desligue a
  variável (kill switch) e reinicie.
