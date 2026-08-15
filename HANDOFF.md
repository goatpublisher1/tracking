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

Run these queries against production and document the results — they inform Tasks 2, 7, and 8:

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

The test suite `test/sql.test.sh` (created in later tasks) will connect to: `postgresql://postgres:test@localhost:55432/postgres`

---

**This handoff must be completed by the repo owner before Tasks 2–8 can run their full test suites.**
