// 角色卡数据层：characters 表的 CRUD + 立绘文件 + ST v2 卡的导入导出。
// 立绘存在 userData/tavern/avatars/，DB 里只记文件名——T9 备份整目录一起走。
import { app, protocol } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { openTavernDb } from './db'
import {
  mergeCardFields,
  parseStCardFull,
  toStCard,
  type CardInput,
  type CardSpec,
  type TavernCard
} from './cardFormat'
import { readCardJson, solidPng, writeCardJson } from './png'

/** 渲染层用 tavern-avatar://local/<文件名> 取图，主进程只放行 avatars/ 下的文件 */
export const AVATAR_SCHEME = 'tavern-avatar'

const DEFAULT_LIST_LIMIT = 24

export interface CardSummary {
  id: string
  name: string
  tags: string[]
  avatarPath: string | null
  /** 描述的第一行截断，网格卡片上显示一行就够 */
  tagline: string
  updatedAt: number
  deleted: boolean
}

export interface CardQuery {
  keyword?: string
  tag?: string
  includeDeleted?: boolean
  onlyDeleted?: boolean
  limit?: number
  offset?: number
}

export interface ImportOutcome {
  file: string
  ok: boolean
  name?: string
  /** true = 同名卡已存在，这次是覆盖更新 */
  updated?: boolean
  error?: string
}

function avatarDir(): string {
  return join(app.getPath('userData'), 'tavern', 'avatars')
}

function avatarFilePath(name: string): string {
  return join(avatarDir(), name)
}

function parseJsonList(text: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(text))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

type Row = Record<string, unknown>

function toCard(row: Row): TavernCard {
  return {
    id: String(row['id']),
    name: String(row['name']),
    description: String(row['description']),
    personality: String(row['personality']),
    scenario: String(row['scenario']),
    firstMes: String(row['first_mes']),
    alternateGreetings: parseJsonList(row['alternate_greetings']),
    mesExample: String(row['mes_example']),
    systemPrompt: String(row['system_prompt']),
    postHistoryInstructions: String(row['post_history_instructions']),
    creator: String(row['creator']),
    creatorNotes: String(row['creator_notes']),
    tags: parseJsonList(row['tags']),
    avatarPath: row['avatar_path'] === null ? null : String(row['avatar_path']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    deletedAt: row['deleted_at'] === null ? null : Number(row['deleted_at'])
  }
}

export function listCards(query: CardQuery = {}): { items: CardSummary[]; total: number } {
  const db = openTavernDb()
  const where: string[] = []
  const params: (string | number)[] = []

  if (query.onlyDeleted) where.push('deleted_at IS NOT NULL')
  else if (!query.includeDeleted) where.push('deleted_at IS NULL')

  const keyword = query.keyword?.trim()
  if (keyword) {
    where.push('(name LIKE ? OR description LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  if (query.tag) {
    // 标签存的是 JSON 数组，查某一项用带引号的片段匹配就够了（本地量级没必要拆关联表）
    where.push('tags LIKE ?')
    params.push(`%"${query.tag}"%`)
  }

  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const countRow = db.prepare(`SELECT COUNT(*) AS n FROM characters${clause}`).get(...params) as Row
  const limit = query.limit ?? DEFAULT_LIST_LIMIT
  const offset = query.offset ?? 0
  const rows = db
    .prepare(
      'SELECT id, name, tags, avatar_path, description, updated_at, deleted_at FROM characters' +
        `${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Row[]

  const items = rows.map((row) => ({
    id: String(row['id']),
    name: String(row['name']),
    tags: parseJsonList(row['tags']),
    avatarPath: row['avatar_path'] === null ? null : String(row['avatar_path']),
    tagline: String(row['description']).replace(/\s+/g, ' ').trim().slice(0, 60),
    updatedAt: Number(row['updated_at']),
    deleted: row['deleted_at'] !== null
  }))
  return { items, total: Number(countRow['n'] ?? 0) }
}

/** 角色库里用到的全部标签（筛选标签用）。SQLite 拆不开 JSON 数组，取回来在 JS 里汇总。 */
export function listTags(): string[] {
  const rows = openTavernDb()
    .prepare('SELECT tags FROM characters WHERE deleted_at IS NULL')
    .all() as Row[]
  const tags = new Set<string>()
  for (const row of rows) for (const tag of parseJsonList(row['tags'])) tags.add(tag)
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

export function getCard(id: string): TavernCard | null {
  const row = openTavernDb().prepare('SELECT * FROM characters WHERE id = ?').get(id) as Row | undefined
  return row ? toCard(row) : null
}

/** 卡里那份原始 data 对象（世界书 / 正则 / 群聊开场白都在里面）。没有就是 null。 */
export function getCardData(id: string): Record<string, unknown> | null {
  const row = openTavernDb().prepare('SELECT data_json FROM characters WHERE id = ?').get(id) as
    | Row
    | undefined
  const text = row?.['data_json']
  if (typeof text !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 这张卡导入时的版本标签（v2 / v3）；新建的卡是 null，导出按 v2 写。 */
function readCardSpec(id: string): CardSpec | null {
  const row = openTavernDb()
    .prepare('SELECT spec, spec_version FROM characters WHERE id = ?')
    .get(id) as Row | undefined
  const spec = row?.['spec']
  const version = row?.['spec_version']
  if (typeof spec !== 'string' || !spec) return null
  return { spec, specVersion: typeof version === 'string' && version ? version : '2.0' }
}

/**
 * 直接在卡里改东西（世界书 / 正则这些只活在 data_json 里的部分）。
 * 改完立刻落库：出库的正文、下一轮的提示词、导出的卡都以 data_json 为准。
 */
export function updateCardData(
  id: string,
  mutate: (data: Record<string, unknown>) => void
): boolean {
  const data = getCardData(id)
  if (!data) return false
  mutate(data)
  const result = openTavernDb()
    .prepare('UPDATE characters SET data_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(data), Date.now(), id)
  return Number(result.changes) > 0
}

/** 新建或更新。返回卡 id；名字为空直接抛错（界面上也拦了一道）。 */
export function saveCard(
  input: CardInput & {
    id?: string
    rawData?: Record<string, unknown> | null
    spec?: CardSpec | null
  }
): string {
  const db = openTavernDb()
  const name = input.name.trim()
  if (!name) throw new Error('角色名不能为空')

  // 编辑页只管这 12 个字段，世界书 / 正则 / 扩展由这里合并保留：
  // 优先用调用方新导入的 rawData（重新导入同一张卡），否则沿用库里原有的 data_json。
  // 新建卡没有原始 data，给个带空 extensions 的底，导出的卡才是结构完整的 v2
  const base = input.rawData ?? (input.id ? getCardData(input.id) : null) ?? { extensions: {} }
  const dataJson = JSON.stringify(mergeCardFields(base, { ...input, name }))
  // 版本标签：重新导入的卡带来新标签就用新的，编辑页保存（没有 rawData）沿用库里记着的。
  // 新建的卡记 null —— 导出的就是 v2，和以前一致
  const spec = input.spec ?? (input.id ? readCardSpec(input.id) : null)

  const fields = [
    name,
    input.description,
    input.personality,
    input.scenario,
    input.firstMes,
    JSON.stringify(input.alternateGreetings),
    input.mesExample,
    input.systemPrompt,
    input.postHistoryInstructions,
    input.creator,
    input.creatorNotes,
    JSON.stringify(input.tags),
    input.avatarPath,
    dataJson,
    spec?.spec ?? null,
    spec?.specVersion ?? null
  ]
  const now = Date.now()

  const previous = input.id ? getCard(input.id) : null
  if (input.id && previous) {
    db.prepare(
      'UPDATE characters SET name = ?, description = ?, personality = ?, scenario = ?, first_mes = ?,' +
        ' alternate_greetings = ?, mes_example = ?, system_prompt = ?, post_history_instructions = ?,' +
        ' creator = ?, creator_notes = ?, tags = ?, avatar_path = ?, data_json = ?, spec = ?,' +
        ' spec_version = ?, updated_at = ?, deleted_at = NULL WHERE id = ?'
    ).run(...fields, now, input.id)
    // 换了立绘就把旧图删掉，否则 avatars/ 里堆的全是没人引用的文件
    //（反复导入同一张 PNG 卡最明显：每次都会新存一份）
    if (previous.avatarPath && previous.avatarPath !== input.avatarPath) removeAvatar(previous.avatarPath)
    return input.id
  }

  const id = randomUUID()
  db.prepare(
    'INSERT INTO characters (name, description, personality, scenario, first_mes, alternate_greetings,' +
      ' mes_example, system_prompt, post_history_instructions, creator, creator_notes, tags, avatar_path,' +
      ' data_json, spec, spec_version, created_at, updated_at, id)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(...fields, now, now, id)
  return id
}

/** 软删：清空角色库后还能从回收站捡回来 */
export function deleteCard(id: string): void {
  const now = Date.now()
  openTavernDb().prepare('UPDATE characters SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
}

export function restoreCard(id: string): void {
  openTavernDb().prepare('UPDATE characters SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id)
}

/** 清空角色库（软删）。返回清掉了几张。 */
export function clearCards(): number {
  const now = Date.now()
  const result = openTavernDb()
    .prepare('UPDATE characters SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL')
    .run(now, now)
  return Number(result.changes)
}

/** 把一张图片存成立绘，返回文件名（随机名，与卡 id 解耦，删卡不必删图）。 */
export function saveAvatar(source: string | Buffer): string {
  mkdirSync(avatarDir(), { recursive: true })
  const name = `${randomUUID()}.png`
  const target = avatarFilePath(name)
  if (Buffer.isBuffer(source)) writeFileSync(target, source)
  else writeFileSync(target, readFileSync(source))
  return name
}

export function avatarExists(name: string): boolean {
  return existsSync(avatarFilePath(name))
}

/** 删掉一张不再被引用的立绘。失败无所谓（文件被占用之类），只是留个垃圾。 */
function removeAvatar(name: string): void {
  try {
    unlinkSync(avatarFilePath(name))
  } catch {
    // 图本来就不在，或者删不掉——不值得让保存失败
  }
}

// ---- 导入 / 导出 ----

function cardFromFile(file: string): {
  input: CardInput
  data: Record<string, unknown>
  spec: CardSpec | null
  avatar: Buffer | null
} {
  const buffer = readFileSync(file)
  if (extname(file).toLowerCase() === '.png') {
    const json = readCardJson(buffer)
    if (!json) throw new Error('这张 PNG 里没有角色卡数据')
    const parsed = parseStCardFull(json)
    return { input: parsed.fields, data: parsed.data, spec: parsed.spec, avatar: buffer }
  }
  const parsed = parseStCardFull(buffer.toString('utf8'))
  return { input: parsed.fields, data: parsed.data, spec: parsed.spec, avatar: null }
}

/** 导入一批卡文件。单张失败不影响其它张，坏在哪张会带在结果里。 */
export function importCardFiles(files: string[]): ImportOutcome[] {
  return files.map((file) => {
    try {
      const { input, data, spec, avatar } = cardFromFile(file)
      const db = openTavernDb()
      // 同名（未删除）的卡视为「重新导入同一张」，更新而不是堆一张重名卡
      const existing = db
        .prepare('SELECT id, avatar_path FROM characters WHERE name = ? AND deleted_at IS NULL')
        .get(input.name) as Row | undefined
      const avatarPath = avatar ? saveAvatar(avatar) : existing ? (existing['avatar_path'] as string | null) : null
      saveCard({
        ...input,
        avatarPath,
        rawData: data,
        spec,
        ...(existing ? { id: String(existing['id']) } : {})
      })
      return { file, ok: true, name: input.name, updated: Boolean(existing) }
    } catch (error) {
      return { file, ok: false, error: (error as Error).message }
    }
  })
}

export function exportCard(id: string, format: 'json' | 'png', dest: string): void {
  const card = getCard(id)
  if (!card) throw new Error('角色不存在')
  // 带上原始 data：世界书 / 正则 / 群聊开场白一起导出，否则就是一张残卡。
  // 版本标签也照原样写回：v3 卡导成 v2，ST 那边就不认 v3 才有的字段了
  const exported = toStCard(card, getCardData(id), readCardSpec(id))

  if (format === 'json') {
    writeFileSync(dest, JSON.stringify(exported, null, 2), 'utf8')
    return
  }
  const base =
    card.avatarPath && avatarExists(card.avatarPath)
      ? readFileSync(avatarFilePath(card.avatarPath))
      : solidPng(512, 512, [14, 26, 46])
  // PNG 里不缩进：卡数据要塞进 tEXt 块，能省一点是一点
  writeFileSync(dest, writeCardJson(base, JSON.stringify(exported)))
}

// ---- 用户人设（替代被砍掉的账号系统，全局一份）----

export interface UserProfile {
  name: string
  description: string
}

const PROFILE_KEY = 'user.persona'

export function loadProfile(): UserProfile {
  const row = openTavernDb().prepare('SELECT value FROM settings WHERE key = ?').get(PROFILE_KEY) as
    | Row
    | undefined
  if (!row) return { name: '旅人', description: '' }
  try {
    const parsed = JSON.parse(String(row['value'])) as Partial<UserProfile>
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : '旅人',
      description: typeof parsed.description === 'string' ? parsed.description : ''
    }
  } catch {
    return { name: '旅人', description: '' }
  }
}

export function saveProfile(profile: UserProfile): void {
  openTavernDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(PROFILE_KEY, JSON.stringify({ name: profile.name.trim() || '旅人', description: profile.description }))
}

// ---- 立绘协议 ----

/**
 * 注册 tavern-avatar:// 协议给 <img src> 用。
 * 渲染层拿不到文件系统，把图 encode 成 data URL 传过去的话，一屏 24 张卡就是几十 MB 的字符串。
 */
export function registerAvatarProtocol(): void {
  protocol.handle(AVATAR_SCHEME, async (request) => {
    const name = basename(decodeURIComponent(new URL(request.url).pathname))
    // 只认我们自己生成的 uuid 文件名，挡住 ../ 之类的路径穿越
    if (!/^[a-z0-9-]+\.png$/i.test(name)) return new Response('bad request', { status: 400 })
    try {
      const data = await readFile(avatarFilePath(name))
      return new Response(data, { headers: { 'content-type': 'image/png' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
