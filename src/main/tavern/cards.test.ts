// 角色卡数据层：CRUD、软删、导入导出、人设。
// 用假 electron 把 userData 指到临时目录，整套（含立绘落盘）真跑一遍。
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  protocol: { handle: (): void => {} }
}))

const { closeTavernDb } = await import('./db')
const {
  clearCards,
  deleteCard,
  exportCard,
  getCard,
  importCardFiles,
  listCards,
  listTags,
  loadProfile,
  restoreCard,
  saveAvatar,
  saveCard,
  saveProfile
} = await import('./cards')
const { readCardJson, solidPng, writeCardJson } = await import('./png')

const base = {
  name: '',
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  alternateGreetings: [],
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  creator: '',
  creatorNotes: '',
  tags: [],
  avatarPath: null
}

function stJson(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name, description: `${name}的描述`, first_mes: `${name}的开场白`, ...extra }
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tavern-cards-'))
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('角色卡 CRUD', () => {
  it('新建 → 读回 → 改一处再存', () => {
    const id = saveCard({ ...base, name: '阿蕾', description: '灯塔看守人', tags: ['奇幻'] })
    const card = getCard(id)
    expect(card?.name).toBe('阿蕾')
    expect(card?.tags).toEqual(['奇幻'])

    saveCard({ ...base, name: '阿蕾', description: '改过的描述', tags: ['奇幻'], id })
    expect(getCard(id)?.description).toBe('改过的描述')
    expect(listCards().total).toBe(1)
  })

  it('名字为空拒绝写入', () => {
    expect(() => saveCard({ ...base, name: '  ' })).toThrow('角色名')
  })

  it('软删：列表里消失，回收站里还在，能恢复', () => {
    const id = saveCard({ ...base, name: '阿蕾' })
    deleteCard(id)

    expect(listCards().total).toBe(0)
    expect(listCards({ onlyDeleted: true }).total).toBe(1)
    expect(listCards({ onlyDeleted: true }).items[0]?.deleted).toBe(true)

    restoreCard(id)
    expect(listCards().total).toBe(1)
  })

  it('清空是软删，返回清掉的数量', () => {
    saveCard({ ...base, name: 'A' })
    saveCard({ ...base, name: 'B' })
    expect(clearCards()).toBe(2)
    expect(listCards().total).toBe(0)
    expect(listCards({ onlyDeleted: true }).total).toBe(2)
  })

  it('搜索与标签筛选', () => {
    saveCard({ ...base, name: '阿蕾', description: '深海灯塔', tags: ['奇幻', '温柔'] })
    saveCard({ ...base, name: '小满', description: '面包店主', tags: ['日常'] })

    expect(listCards({ keyword: '灯塔' }).items.map((item) => item.name)).toEqual(['阿蕾'])
    expect(listCards({ tag: '日常' }).items.map((item) => item.name)).toEqual(['小满'])
    expect(listTags()).toEqual(['奇幻', '日常', '温柔'].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
  })

  it('分页：limit / offset 与 total 对得上', () => {
    for (let i = 0; i < 5; i++) saveCard({ ...base, name: `角色${i}` })
    const first = listCards({ limit: 2 })
    expect(first.total).toBe(5)
    expect(first.items).toHaveLength(2)
    const second = listCards({ limit: 2, offset: 2 })
    expect(second.items.map((item) => item.id)).not.toEqual(first.items.map((item) => item.id))
  })
})

describe('导入 / 导出', () => {
  it('导入 JSON 卡：字段进库，没有立绘', () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, stJson('阿蕾', { personality: '安静' }))
    const [outcome] = importCardFiles([file])

    expect(outcome?.ok).toBe(true)
    expect(outcome?.name).toBe('阿蕾')
    const card = listCards().items[0]!
    expect(card.avatarPath).toBeNull()
    expect(getCard(card.id)?.personality).toBe('安静')
  })

  it('导入 PNG 卡：卡数据进库，图存进 avatars/', () => {
    const png = writeCardJson(solidPng(8, 8, [1, 2, 3]), stJson('阿蕾'))
    const file = join(dir, 'a.png')
    writeFileSync(file, png)

    const [outcome] = importCardFiles([file])
    expect(outcome?.ok).toBe(true)
    const card = listCards().items[0]!
    expect(card.avatarPath).toMatch(/^[a-z0-9-]+\.png$/i)
    // 落盘的立绘与源图一致
    expect(readFileSync(join(dir, 'tavern', 'avatars', card.avatarPath!)).equals(png)).toBe(true)
  })

  it('同名 PNG 卡再导入一次：旧立绘从 avatars/ 删掉，不留孤儿文件', () => {
    const first = join(dir, 'a.png')
    writeFileSync(first, writeCardJson(solidPng(8, 8, [1, 1, 1]), stJson('阿蕾')))
    importCardFiles([first])
    const oldAvatar = getCard(listCards().items[0]!.id)!.avatarPath!

    // 换一张图，同名再导入 → 覆盖更新
    const second = join(dir, 'b.png')
    const newer = writeCardJson(solidPng(8, 8, [2, 2, 2]), stJson('阿蕾'))
    writeFileSync(second, newer)
    importCardFiles([second])

    const newAvatar = getCard(listCards().items[0]!.id)!.avatarPath!
    expect(newAvatar).not.toBe(oldAvatar)
    // 反复导入同一张卡会在 avatars/ 里堆垃圾，旧图必须被清掉
    expect(readdirSync(join(dir, 'tavern', 'avatars'))).toEqual([newAvatar])
    expect(readFileSync(join(dir, 'tavern', 'avatars', newAvatar)).equals(newer)).toBe(true)
  })

  it('同名卡再导入一次是覆盖，不会堆出两张', () => {
    const first = join(dir, 'a.json')
    writeFileSync(first, stJson('阿蕾'))
    importCardFiles([first])

    const second = join(dir, 'b.json')
    writeFileSync(second, stJson('阿蕾', { description: '新版描述' }))
    const [outcome] = importCardFiles([second])

    expect(outcome?.updated).toBe(true)
    expect(listCards().total).toBe(1)
    expect(getCard(listCards().items[0]!.id)?.description).toBe('新版描述')
  })

  it('坏文件只影响自己那一张', () => {
    const good = join(dir, 'good.json')
    writeFileSync(good, stJson('阿蕾'))
    const bad = join(dir, 'bad.png')
    writeFileSync(bad, solidPng(2, 2, [0, 0, 0])) // 是 PNG，但里面没有卡
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ 不是 json')

    const results = importCardFiles([good, bad, broken])
    expect(results.map((item) => item.ok)).toEqual([true, false, false])
    expect(listCards().total).toBe(1)
  })

  it('导出 JSON 能被自己重新导入', () => {
    const id = saveCard({ ...base, name: '阿蕾', firstMes: '你来了。', alternateGreetings: ['备选'] })
    const dest = join(dir, 'out.json')
    exportCard(id, 'json', dest)

    const parsed = JSON.parse(readFileSync(dest, 'utf8')) as { data?: { name?: string } }
    expect(parsed.data?.name).toBe('阿蕾')

    importCardFiles([dest])
    // 同名覆盖，仍然只有一张
    expect(listCards().total).toBe(1)
    expect(getCard(listCards().items[0]!.id)?.alternateGreetings).toEqual(['备选'])
  })

  it('导出的 PNG 里带着卡数据（ST 就是读这个块）', () => {
    const id = saveCard({ ...base, name: '阿蕾' })
    const dest = join(dir, 'out.png')
    exportCard(id, 'png', dest)

    const json = readCardJson(readFileSync(dest))
    expect(json).not.toBeNull()
    expect(JSON.parse(json!).data.name).toBe('阿蕾')
  })

  it('有立绘时导出 PNG 用立绘原图', () => {
    const source = join(dir, 'src.png')
    writeFileSync(source, solidPng(16, 16, [9, 9, 9]))
    const avatarPath = saveAvatar(source)
    const id = saveCard({ ...base, name: '阿蕾', avatarPath })

    const dest = join(dir, 'out.png')
    exportCard(id, 'png', dest)
    expect(readCardJson(readFileSync(dest))).not.toBeNull()
    // 原图 16×16 的 IHDR 尺寸还在（宽度写在 IHDR 第 8 字节起）
    const png = readFileSync(dest)
    expect(png.readUInt32BE(16)).toBe(16)
  })

  // 编辑页只改 12 个平铺字段，世界书 / 正则 / 群聊开场白不能因此失踪
  const richData = {
    name: '苏月珑',
    description: '旧描述',
    first_mes: '徒儿，起床了',
    group_only_greetings: ['群聊开场'],
    character_book: {
      name: '设定',
      entries: [{ keys: ['月珑峰'], content: '灵峰', constant: false, position: 'before_char' }]
    },
    extensions: { piupiu_regex: { enabled: true, scripts: [{ findRegex: '<update>' }] } }
  }

  function importRich(): string {
    const file = join(dir, 'rich.json')
    writeFileSync(file, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: richData }))
    importCardFiles([file])
    return listCards().items[0]!.id
  }

  it('带世界书的卡：编辑描述再导出，世界书 / 扩展 / 群聊开场白逐字还在', () => {
    const id = importRich()
    saveCard({ ...base, name: '苏月珑', description: '新描述', id })

    const dest = join(dir, 'out.json')
    exportCard(id, 'json', dest)
    const data = (JSON.parse(readFileSync(dest, 'utf8')) as { data: Record<string, unknown> }).data

    expect(data['description']).toBe('新描述')
    expect(data['character_book']).toEqual(richData.character_book)
    expect(data['extensions']).toEqual(richData.extensions)
    expect(data['group_only_greetings']).toEqual(['群聊开场'])
  })

  it('导出再导入一次，世界书仍然完整（往返不掉东西）', () => {
    const id = importRich()
    const first = join(dir, 'round1.json')
    exportCard(id, 'json', first)

    importCardFiles([first])
    const second = join(dir, 'round2.json')
    exportCard(listCards().items[0]!.id, 'json', second)

    const a = JSON.parse(readFileSync(first, 'utf8')) as { data: Record<string, unknown> }
    const b = JSON.parse(readFileSync(second, 'utf8')) as { data: Record<string, unknown> }
    expect(b.data).toEqual(a.data)
  })

  it('PNG 导出同样带着世界书', () => {
    const id = importRich()
    const dest = join(dir, 'out.png')
    exportCard(id, 'png', dest)
    const data = (JSON.parse(readCardJson(readFileSync(dest))!) as { data: Record<string, unknown> }).data
    expect(data['character_book']).toEqual(richData.character_book)
  })

  it('新建的卡没有原始 data，导出仍是一张合法 v2 卡', () => {
    const id = saveCard({ ...base, name: '阿蕾' })
    const dest = join(dir, 'new.json')
    exportCard(id, 'json', dest)
    const card = JSON.parse(readFileSync(dest, 'utf8')) as { spec: string; data: Record<string, unknown> }
    expect(card.spec).toBe('chara_card_v2')
    expect(card.data['name']).toBe('阿蕾')
    expect(card.data['extensions']).toEqual({})
  })

  it('v3 卡导入后导出仍是 v3（编辑过也一样）', () => {
    const file = join(dir, 'v3.json')
    writeFileSync(
      file,
      JSON.stringify({
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: { name: '赵泠', description: '旧描述', nickname: '小泠' }
      })
    )
    importCardFiles([file])
    const id = listCards().items[0]!.id
    // 编辑页保存不带 rawData：版本标签要从库里接着用，不能因为存了一次就掉回 v2
    saveCard({ ...base, name: '赵泠', description: '新描述', id })

    const dest = join(dir, 'v3-out.json')
    exportCard(id, 'json', dest)
    const card = JSON.parse(readFileSync(dest, 'utf8')) as {
      spec: string
      spec_version: string
      data: Record<string, unknown>
    }
    expect(card.spec).toBe('chara_card_v3')
    expect(card.spec_version).toBe('3.0')
    expect(card.data['nickname']).toBe('小泠')
  })
})

describe('用户人设', () => {
  it('默认是「旅人」，存过之后读回来', () => {
    expect(loadProfile()).toEqual({ name: '旅人', description: '' })
    saveProfile({ name: '小满', description: '住在海边' })
    expect(loadProfile()).toEqual({ name: '小满', description: '住在海边' })
    // 名字留空回落到默认，不会存出空名字
    saveProfile({ name: '   ', description: 'x' })
    expect(loadProfile().name).toBe('旅人')
  })
})
