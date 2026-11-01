// 建库与迁移只能在启动时跑一次，出问题就是「点开酒馆一片空白」，
// 没有日志也看不出是哪张表建歪了。这里用假 electron 指向临时目录，把整套走一遍。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const { closeTavernDb, openTavernDb, tableNames, tavernDbPath } = await import('./db')

let instance: ReturnType<typeof openTavernDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tavern-db-'))
  instance = openTavernDb()
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('酒馆数据库', () => {
  it('建在 userData 下的 tavern.db', () => {
    expect(tavernDbPath()).toBe(join(dir, 'tavern.db'))
  })

  it('迁移后 14 张业务表齐全', () => {
    const tables = tableNames(instance)
    for (const name of [
      'characters',
      'chats',
      'messages',
      'chat_summaries',
      'memories',
      'memory_vectors',
      'lorebooks',
      'lorebook_entries',
      'regexes',
      'presets',
      'preset_entries',
      'status_bars',
      'status_items',
      'settings'
    ]) {
      expect(tables, `缺表 ${name}`).toContain(name)
    }
  })

  it('开了 WAL 与外键', () => {
    const mode = instance.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(mode.journal_mode).toBe('wal')
    const fk = instance.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)
  })

  it('外键真的生效：往不存在的会话里插消息会被拒', () => {
    expect(() =>
      instance
        .prepare(
          'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run('m1', 'no-such-chat', 'user', 'hi', Date.now())
    ).toThrow()
  })

  it('重启不重复跑迁移', () => {
    closeTavernDb()
    const again = openTavernDb()
    const rows = again.prepare('SELECT version FROM schema_version ORDER BY version').all()
    // 每条迁移只记一次：列表跟着 MIGRATIONS 走，加一个就多一条
    expect(rows.map((row) => Number((row as { version: number }).version))).toEqual([
      1, 2, 3, 4, 5, 6
    ])
  })

  it('迁移失败要关掉连接：坏库能立刻删掉，不会泄漏句柄', () => {
    closeTavernDb()
    // 写一堆不是 SQLite 的字节：打开时 PRAGMA 就会抛「file is not a database」
    writeFileSync(tavernDbPath(), 'not a sqlite file')
    expect(() => openTavernDb()).toThrow()
    // 连接没关的话，Windows 上这个文件是删不掉的（用户恢复坏库就只有删文件这一条路）
    expect(() => rmSync(tavernDbPath())).not.toThrow()
  })
})
