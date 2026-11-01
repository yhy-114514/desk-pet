// 酒馆数据层：Electron 内置的 node:sqlite（Electron 44 → Node 24.22，无需开关、零 native 模块）。
// 只给酒馆用——鲸鱼娘自己的 config / 记忆 / 历史仍是原来的 JSON，一个字节都不动。
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { join } from 'node:path'
import initSql from './migrations/000_init.sql?raw'
import cardRawSql from './migrations/001_card_raw.sql?raw'
import t4Sql from './migrations/002_t4.sql?raw'
import cardSpecSql from './migrations/003_card_spec.sql?raw'
import chatModelSql from './migrations/004_chat_model.sql?raw'
import chatMaxTokensSql from './migrations/005_chat_max_tokens.sql?raw'

interface Migration {
  version: number
  name: string
  sql: string
}

// 只能追加，不能改已发布的条目（schema_version 里记着谁跑过了）
const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: initSql },
  { version: 2, name: 'card_raw', sql: cardRawSql },
  { version: 3, name: 't4', sql: t4Sql },
  { version: 4, name: 'card_spec', sql: cardSpecSql },
  { version: 5, name: 'chat_model', sql: chatModelSql },
  { version: 6, name: 'chat_max_tokens', sql: chatMaxTokensSql }
]

const DB_FILE = 'tavern.db'

let db: DatabaseSync | null = null

export function tavernDbPath(): string {
  return join(app.getPath('userData'), DB_FILE)
}

/** 打开（首次会建库并跑迁移）。重复调用返回同一个连接。 */
export function openTavernDb(): DatabaseSync {
  if (db) return db
  const instance = new DatabaseSync(tavernDbPath())
  try {
    // WAL：读写不互相阻塞，聊天流式写入时界面查历史不会被卡住。
    // 代价是数据可能还在 -wal 文件里，T9 备份前必须先 checkpoint。
    instance.exec('PRAGMA journal_mode = WAL')
    instance.exec('PRAGMA foreign_keys = ON')
    migrate(instance)
  } catch (error) {
    // 必须在这里关掉：db 仍是 null，下一次 openTavernDb() 会重新 new 一个，
    // 不关就是「每开一次酒馆窗口泄漏一个句柄」，Windows 上还会锁住 tavern.db
    // 让用户删不掉、换不了（坏库恢复就得靠删文件）
    instance.close()
    throw error
  }
  db = instance
  return instance
}

/**
 * 把 WAL 里的数据合并回主库并清空 -wal。
 * 备份前必须做：直接拷 `tavern.db` 会漏掉还在 -wal 里的未 checkpoint 数据。
 */
export function checkpointTavernDb(): void {
  if (!db) return
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
}

export function closeTavernDb(): void {
  if (!db) return
  db.close() // close 会把 WAL 合并回主库
  db = null
}

/** 当前已有的表名（T0 的验收口子：看得见 schema 才算建成功）。 */
export function tableNames(instance: DatabaseSync): string[] {
  const rows = instance
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
  return rows.map((row) => String((row as { name: unknown }).name))
}

function migrate(instance: DatabaseSync): void {
  instance.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (' +
      "version INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', applied_at INTEGER NOT NULL)"
  )
  const applied = new Set(
    instance
      .prepare('SELECT version FROM schema_version')
      .all()
      .map((row) => Number((row as { version: unknown }).version))
  )
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    // 一个迁移一个事务：中途失败不能留下半套表
    instance.exec('BEGIN')
    try {
      instance.exec(migration.sql)
      instance
        .prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, Date.now())
      instance.exec('COMMIT')
    } catch (error) {
      instance.exec('ROLLBACK')
      throw new Error(
        `酒馆数据库迁移 ${migration.version}_${migration.name} 失败：${(error as Error).message}`
      )
    }
  }
}
