import { Database } from 'bun:sqlite'

/** DB 栈验证:bun:sqlite 原语在 Bun 下可用(W5 上 drizzle/bun-sqlite;禁 better-sqlite3)。 */
const db = new Database(':memory:')
db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
db.run("INSERT INTO t (name) VALUES ('billiards')")
const row = db.query('SELECT name FROM t WHERE id = 1').get() as { name: string } | null
if (!row || row.name !== 'billiards') {
  console.error('FAIL bun:sqlite round-trip')
  process.exit(1)
}
console.log('OK bun:sqlite round-trip:', row.name)
