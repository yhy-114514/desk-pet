// 备份与恢复：把 userData 里需要带走的东西打成一个 .zip，导入时原样写回。
//
// 两份存储都要顾到：酒馆的 SQLite（tavern.db + 立绘 / 媒体目录）和鲸鱼娘自己的
// 几个 JSON（配置 / 记忆 / 提醒）。userDataDir 参数化传入，单测能拿临时目录跑。
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { checkpointTavernDb, closeTavernDb } from './db'

const DB_FILE = 'tavern.db'
/** 这两个目录里是用户资产（立绘 / 背景音乐 / 背景图），要递归整目录带走 */
const ASSET_DIRS = ['tavern/avatars', 'tavern/media']
/**
 * SQLite 的运行时文件。checkpoint 之后数据全在主库里，它们不该进备份：
 * 这些文件跟「打开它的那个进程」绑在一起，搬到别处（或跟另一份库拼在一起）
 * 会被当成损坏的日志，重启后直接卡在打不开库上。
 */
const SIDECAR_FILES = [`${DB_FILE}-wal`, `${DB_FILE}-shm`]

export interface BackupResult {
  ok: boolean
  path?: string
  /** 导入成功后怎么重启：auto = 应用自己 relaunch；manual = 开发模式下只能用户自己重跑 */
  restart?: 'auto' | 'manual'
  error?: string
}

/** userData 顶层的 JSON（配置 / 聊天历史 / 记忆 / 向量 / 提醒 / 窗口位置等） */
function topLevelJson(userDataDir: string): string[] {
  return readdirSync(userDataDir).filter((name) => {
    if (!name.endsWith('.json')) return false
    try {
      return statSync(join(userDataDir, name)).isFile()
    } catch {
      return false
    }
  })
}

/** 只允许备份清单里的路径，导入时用它挡掉 zip 里夹带的其它文件 */
function allowedEntry(rel: string): boolean {
  if (/^[^/]+\.json$/.test(rel)) return true
  // 老备份里可能带着 -wal / -shm：一律不还原（见 SIDECAR_FILES）
  return rel === DB_FILE || ASSET_DIRS.some((dir) => rel.startsWith(`${dir}/`))
}

/** zip 条目名统一成 `/` 分隔（Windows 上写进去的可能是反斜杠） */
function normalize(name: string): string {
  return name.replace(/\\/g, '/')
}

/**
 * 导出：先 checkpoint（把 -wal 合并回主库），再把清单里的文件打进 targetPath。
 * 数据库还没建过时也允许导出——至少把 JSON 配置带走。
 */
export function exportBackup(userDataDir: string, targetPath: string): BackupResult {
  try {
    checkpointTavernDb()
    const zip = new AdmZip()
    for (const name of topLevelJson(userDataDir)) zip.addLocalFile(join(userDataDir, name))
    const dbFile = join(userDataDir, DB_FILE)
    if (existsSync(dbFile)) zip.addLocalFile(dbFile)
    for (const dir of ASSET_DIRS) {
      const folder = join(userDataDir, dir)
      if (existsSync(folder)) zip.addLocalFolder(folder, dir)
    }
    zip.writeZip(targetPath)
    return { ok: true, path: targetPath }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/**
 * 恢复：校验确实是酒馆备份（必须带 tavern.db），关库后把清单内的文件覆盖写回。
 * 调用方负责在成功之后重启应用——库里还挂着旧连接，热替换只会读到半新半旧的页。
 */
export function importBackup(userDataDir: string, sourcePath: string): BackupResult {
  try {
    const zip = new AdmZip(sourcePath)
    const entries = zip.getEntries()
    const names = new Set(entries.map((entry) => normalize(entry.entryName)))
    if (!names.has(DB_FILE)) {
      return { ok: false, error: '这个压缩包里没有 tavern.db，不是酒馆的备份文件。' }
    }
    // 关库再覆盖：Windows 上打开着的文件写不进去，而且页缓存会和磁盘上的新库对不上
    closeTavernDb()
    const root = resolve(userDataDir)
    // 旧库留下的 -wal / -shm 必须清掉：新库第一次打开时会把它们当成自己的日志，
    // 内容对不上就是「数据库打不开 / 卡住」。备份里也不带这两个文件，直接删干净。
    for (const name of SIDECAR_FILES) rmSync(join(root, name), { force: true })
    for (const entry of entries) {
      if (entry.isDirectory) continue
      const rel = normalize(entry.entryName)
      if (!allowedEntry(rel) || rel.includes('..')) continue
      const target = resolve(root, rel)
      // 防路径穿越：解析后必须仍落在 userData 之内
      if (target !== root && !target.startsWith(root + sep)) continue
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.getData())
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}
