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
