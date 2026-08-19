// =====================================================================
//  q.js — roda uma query no banco de dentro do container.
//  A imagem e node:20-slim, sem psql; este script usa o `pg` que ja esta
//  instalado e o DATABASE_URL que ja esta no ambiente.
//  Uso: node scripts/q.js "SELECT ..."
//  SELECT imprime tabela; INSERT/UPDATE/ALTER imprime linhas afetadas.
// =====================================================================
const { Pool } = require('pg');

const sql = process.argv[2];
if (!sql) {
  console.error('uso: node scripts/q.js "SELECT ..."');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(sql)
  .then(r => {
    if (r.rows && r.rows.length) console.table(r.rows);
    else console.log(r.command, '- linhas afetadas:', r.rowCount);
    return pool.end();
  })
  .catch(e => { console.error('ERRO:', e.message); return pool.end(); });
