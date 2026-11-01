// 备份 / 恢复：整目录打包、只收清单内的文件、还原后内容一致。
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
vi.mock('electron', () => ({ app: { getPath: () => dir }, protocol: { handle: (): void => {} } }))

const { exportBackup, importBackup } = await import('./backup')
const { closeTavernDb } = await import('./db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tavern-backup-'))
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

/** 造一份像样的 userData：JSON 配置 + 酒馆库 + 立绘 / 媒体资产 + 一个不该进包的杂物 */
function seed(root: string): void {
  mkdirSync(join(root, 'tavern/avatars'), { recursive: true })
  mkdirSync(join(root, 'tavern/media'), { recursive: true })
  writeFileSync(join(root, 'config.json'), '{"model":"deepseek-flash"}')
  writeFileSync(join(root, 'memory.json'), '{"items":[]}')
  writeFileSync(join(root, 'tavern.db'), 'fake-db-bytes')
  writeFileSync(join(root, 'tavern/avatars/a.png'), 'png-bytes')
  writeFileSync(join(root, 'tavern/media/bgm.mp3'), 'mp3-bytes')
  writeFileSync(join(root, 'unrelated.txt'), '不该被备份')
}

describe('备份与恢复', () => {
  it('导出再导入，清单里的文件原样回来，杂物不跟着走', () => {
    seed(dir)
    const zipPath = join(dir, 'out.zip')
    expect(exportBackup(dir, zipPath)).toEqual({ ok: true, path: zipPath })

    const names = new AdmZip(zipPath).getEntries().map((entry) => entry.entryName.replace(/\\/g, '/'))
    expect(names).toEqual(
      expect.arrayContaining(['config.json', 'memory.json', 'tavern.db', 'tavern/avatars/a.png', 'tavern/media/bgm.mp3'])
    )
    expect(names).not.toContain('unrelated.txt')

    const restored = mkdtempSync(join(tmpdir(), 'tavern-restore-'))
    try {
      expect(importBackup(restored, zipPath)).toEqual({ ok: true })
      expect(readFileSync(join(restored, 'config.json'), 'utf8')).toBe('{"model":"deepseek-flash"}')
      expect(readFileSync(join(restored, 'tavern.db'), 'utf8')).toBe('fake-db-bytes')
      expect(readFileSync(join(restored, 'tavern/avatars/a.png'), 'utf8')).toBe('png-bytes')
      expect(readFileSync(join(restored, 'tavern/media/bgm.mp3'), 'utf8')).toBe('mp3-bytes')
      expect(existsSync(join(restored, 'unrelated.txt'))).toBe(false)
    } finally {
      rmSync(restored, { recursive: true, force: true })
    }
  })

  it('WAL 运行时文件不进备份，导入时也不还原、还要把旧的删掉', () => {
    seed(dir)
    // 主库旁边常见的两个 SQLite 运行时文件（真实导出前会 checkpoint 合并掉）
    writeFileSync(join(dir, 'tavern.db-wal'), 'stale-wal')
    writeFileSync(join(dir, 'tavern.db-shm'), 'stale-shm')

    const zipPath = join(dir, 'out.zip')
    expect(exportBackup(dir, zipPath).ok).toBe(true)
    const names = new AdmZip(zipPath).getEntries().map((entry) => entry.entryName.replace(/\\/g, '/'))
    expect(names).toContain('tavern.db')
    expect(names).not.toContain('tavern.db-wal')
    expect(names).not.toContain('tavern.db-shm')

    // 目标目录里已经有一份旧库留下的 -wal / -shm：新库打开时会把它们当成自己的日志
    const restored = mkdtempSync(join(tmpdir(), 'tavern-restore-'))
    try {
      writeFileSync(join(restored, 'tavern.db-wal'), 'old-wal')
      writeFileSync(join(restored, 'tavern.db-shm'), 'old-shm')
      expect(importBackup(restored, zipPath)).toEqual({ ok: true })
      expect(readFileSync(join(restored, 'tavern.db'), 'utf8')).toBe('fake-db-bytes')
      expect(existsSync(join(restored, 'tavern.db-wal'))).toBe(false)
      expect(existsSync(join(restored, 'tavern.db-shm'))).toBe(false)
    } finally {
      rmSync(restored, { recursive: true, force: true })
    }
  })

  it('老备份里带着 -wal / -shm 也不还原（避免和主库对不上）', () => {
    seed(dir)
    const zipPath = join(dir, 'legacy.zip')
    const zip = new AdmZip()
    zip.addFile('tavern.db', Buffer.from('fake-db-bytes'))
    zip.addFile('tavern.db-wal', Buffer.from('legacy-wal'))
    zip.addFile('tavern.db-shm', Buffer.from('legacy-shm'))
    zip.writeZip(zipPath)

    const restored = mkdtempSync(join(tmpdir(), 'tavern-restore-'))
    try {
      expect(importBackup(restored, zipPath)).toEqual({ ok: true })
      expect(existsSync(join(restored, 'tavern.db'))).toBe(true)
      expect(existsSync(join(restored, 'tavern.db-wal'))).toBe(false)
      expect(existsSync(join(restored, 'tavern.db-shm'))).toBe(false)
    } finally {
      rmSync(restored, { recursive: true, force: true })
    }
  })

  it('没有 tavern.db 的压缩包不算酒馆备份，拒绝导入', () => {
    const zipPath = join(dir, 'not-a-backup.zip')
    const zip = new AdmZip()
    zip.addFile('config.json', Buffer.from('{}'))
    zip.writeZip(zipPath)

    const target = join(dir, 'should-not-exist')
    const result = importBackup(target, zipPath)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('tavern.db')
  })

  it('压缩包里夹带的路径穿越条目被忽略', () => {
    seed(dir)
    const zipPath = join(dir, 'evil.zip')
    const zip = new AdmZip()
    zip.addFile('tavern.db', Buffer.from('fake-db-bytes'))
    zip.addFile('tavern/avatars/../../../escaped.txt', Buffer.from('escape'))
    zip.writeZip(zipPath)

    const restored = mkdtempSync(join(tmpdir(), 'tavern-restore-'))
    try {
      expect(importBackup(restored, zipPath)).toEqual({ ok: true })
      expect(existsSync(join(restored, 'tavern.db'))).toBe(true)
      expect(existsSync(join(restored, '..', 'escaped.txt'))).toBe(false)
    } finally {
      rmSync(restored, { recursive: true, force: true })
    }
  })
})
