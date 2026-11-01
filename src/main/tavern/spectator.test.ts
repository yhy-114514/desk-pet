// 鲸鱼娘旁观的请求装配：只验「读到了什么材料」和「发出去的 system / user 对不对」，
// 不真发请求。库照常建在临时目录，观战全程只读。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  protocol: { handle: (): void => {} }
}))

const ds = vi.hoisted(() => ({
  /** 这一轮「模型」的回复原文（可以是带标记的，用来验清洗） */
  reply: '好。',
  /** 体检走 completeChat：这里放它返回的 JSON 原文 */
  diagnosis: '{"issues":[]}'
}))
const prompts: Array<Array<{ role: string; content: string }>> = []
const completes: Array<{
  jsonMode?: boolean
  disableThinking?: boolean
  messages: Array<{ content: string }>
}> = []

vi.mock('../chat/deepseek', () => ({
  streamChat: async (opts: {
    messages: Array<{ role: string; content: string }>
    onToken: (delta: string) => void
  }): Promise<string> => {
    prompts.push(opts.messages)
    opts.onToken(ds.reply)
    return ds.reply
  },
  completeChat: async (opts: {
    jsonMode?: boolean
    disableThinking?: boolean
    messages: Array<{ content: string }>
  }): Promise<string> => {
    completes.push(opts)
    return ds.diagnosis
  }
}))

vi.mock('../chat/config', () => ({
  loadConfig: (): { apiKey: string; qwenKey: string; model: string } => ({
    apiKey: 'test-key',
    qwenKey: '',
    model: 'test-model'
  })
}))

const { closeTavernDb, openTavernDb } = await import('./db')
const { appendMessage, createChat, activePath } = await import('./chatStore')
const { getCard, getCardData, saveCard, updateCardData } = await import('./cards')
const { readCardRegexes } = await import('./regexEngine')
const { readCardEntries } = await import('./worldbook')
const { saveExtracted } = await import('./memoryStore')
const {
  applyCardFix,
  askCardAssistant,
  askSpectator,
  buildCardContext,
  buildFullCardContext,
  buildObserveContext,
  diagnoseCard,
  formatFullCardContext,
  formatObserveContext,
  parseDiagnosis,
  spectatorSystem
} = await import('./spectator')

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tavern-spectator-'))
  prompts.length = 0
  completes.length = 0
  ds.reply = '好。'
  ds.diagnosis = '{"issues":[]}'
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

function seed(name = '苏月珑'): { characterId: string; chatId: string } {
  const characterId = saveCard({
    ...base,
    name,
    description: '{{char}}是隐居山门的剑修师父。',
    personality: '清冷，话少'
  })
  const chat = createChat(characterId, Math.random, null)
  appendMessage(chat.id, null, 'user', '师父在吗')
  appendMessage(chat.id, activePath(chat.id)[0]!.id, 'assistant', '在山门外等你。')
  return { characterId, chatId: chat.id }
}

function seedDossier(chatId: string, keyEvent = '她独自守着山门'): void {
  const path = activePath(chatId)
  openTavernDb()
    .prepare(
      'INSERT INTO chat_summaries (id, chat_id, from_message_id, to_message_id, dossier, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      `summary-${chatId}`,
      chatId,
      path[0]!.id,
      path[path.length - 1]!.id,
      JSON.stringify({
        card_name: '苏月珑',
        world_brief: '云雾山门，剑修一脉。',
        player_character: '刚入门的小徒弟',
        scene_now: '山门外落着雨',
        key_events: [keyEvent],
        open_threads: ['师父的旧伤'],
        char_relations: [{ char: '苏月珑', relation_to_player: '师徒', attitude: '嘴上冷淡' }],
        tone: '清冷',
        updated_at: '2026-10-31'
      }),
      Date.now()
    )
}

describe('观战上下文', () => {
  it('把观测档案 / 最近剧情 / 记忆都拼进来', () => {
    const { characterId, chatId } = seed()
    seedDossier(chatId)
    saveExtracted(characterId, [{ type: 'fact', content: '师父爱吃桂花糕' }])

    const context = buildObserveContext(chatId)!
    expect(context.cardName).toBe('苏月珑')
    const text = formatObserveContext(context)
    expect(text).toContain('剧情节点')
    expect(text).toContain('她独自守着山门')
    expect(text).toContain('师父的旧伤')
    expect(text).toContain('最近剧情')
    expect(text).toContain('师父在吗')
    expect(text).toContain('师父爱吃桂花糕')
  })

  it('没有档案时明说「看不清」，不让她硬编', () => {
    const { chatId } = seed()
    const text = formatObserveContext(buildObserveContext(chatId)!)
    expect(text).toContain('还没有')
    expect(text).toContain('最近剧情')
  })

  it('只看这一场：别的会话的剧情不会混进来', () => {
    const a = seed('苏月珑')
    const b = seed('赵泠')
    seedDossier(a.chatId, '甲：她独自守着山门')
    seedDossier(b.chatId, '乙：赵泠去了南边')

    const textA = formatObserveContext(buildObserveContext(a.chatId)!)
    expect(textA).toContain('她独自守着山门')
    expect(textA).not.toContain('赵泠')
    expect(textA).not.toContain('乙：')
  })
})

describe('观战问答', () => {
  it('system 是人设 + 档案，user 只有问题；返回时洗掉标记', async () => {
    const { chatId } = seed()
    seedDossier(chatId)
    ds.reply = '<emo:shy>刚才啊……<remind at="20:00">提醒他</remind>她一直在山门外等着。'

    const tokens: string[] = []
    const text = await askSpectator({
      chatId,
      question: '刚才发生了什么？',
      onToken: (delta) => tokens.push(delta)
    })

    const system = prompts[0]![0]!.content
    expect(system).toContain('鲸鱼娘')
    expect(system).toContain('旁观者的口吻')
    expect(system).toContain('剧情节点')
    expect(prompts[0]![1]).toEqual({ role: 'user', content: '刚才发生了什么？' })

    expect(text).not.toContain('<emo:')
    expect(text).not.toContain('<remind')
    expect(text).toContain('她一直在山门外等着')
    expect(tokens.join('')).not.toContain('emo')
    expect(tokens.join('')).not.toContain('remind')
  })

  it('灵感模式要求给剧情方向并引用真实节点', async () => {
    const { chatId } = seed()
    seedDossier(chatId)
    await askSpectator({ chatId, question: '接下来怎么走？', mode: 'idea' })
    const system = prompts[0]![0]!.content
    expect(system).toContain('往下走的方向')
    expect(system).toContain('真实存在的')
  })

  it('问答不碰消息树（只读）', async () => {
    const { chatId } = seed()
    const before = activePath(chatId).length
    await askSpectator({ chatId, question: '刚才发生了什么？' })
    expect(activePath(chatId).length).toBe(before)
  })

  it('问题为空时直接拒绝，不发请求', async () => {
    const { chatId } = seed()
    await expect(askSpectator({ chatId, question: '   ' })).rejects.toThrow('先说说你想问什么')
    expect(prompts.length).toBe(0)
  })

  it('模型一个字都没吐出来时报错，不留空气泡', async () => {
    const { chatId } = seed()
    // 推理 token 吃光预算时就是这个形状：content 为空、finish_reason=length
    ds.reply = ''
    await expect(askSpectator({ chatId, question: '刚才发生了什么？' })).rejects.toThrow(
      '没说出来'
    )
  })
})

describe('角色卡助手', () => {
  it('材料里有卡字段和世界书条目名，问答同样只读', async () => {
    const characterId = saveCard({
      ...base,
      name: '阿蕾',
      description: '{{char}}是森林里的药师。',
      personality: '温柔'
    })
    // 卡内世界书：审卡要能看到条目名，才知道有没有互相打架
    const { updateCardData } = await import('./cards')
    updateCardData(characterId, (data) => {
      data['character_book'] = {
        entries: [
          { comment: '药铺的规矩', keys: ['药铺'], content: '日落前必须关门。' },
          { comment: '阿蕾的旧伤', keys: ['旧伤'], content: '左肩受过箭伤。' }
        ]
      }
    })

    const context = buildCardContext(characterId)!
    expect(context.entries.map((item) => item.name)).toEqual(['药铺的规矩', '阿蕾的旧伤'])

    await askCardAssistant({ characterId, question: '设定有没有矛盾？' })
    const system = prompts[0]![0]!.content
    expect(system).toContain('森林里的药师')
    expect(system).toContain('阿蕾的旧伤')
    expect(system).toContain('卡里没写的就说')
  })
})

describe('角色卡体检', () => {
  /** 一张「有毛病」的卡：正则把单引号换成中文引号（会洗崩自己的 JS），还有条空世界书 */
  function seedSickCard(): string {
    const id = saveCard({
      ...base,
      name: '镇魔司',
      description: '{{char}}是镇魔司的司主。',
      firstMes: '夜里，司主推开门。'
    })
    updateCardData(id, (data) => {
      data['character_book'] = {
        entries: [
          { comment: '夜里不许出门', keys: ['夜'], content: '入夜后任何人不得离开房间。' },
          { comment: '没人写的条目', keys: [], content: '' }
        ]
      }
      data['extensions'] = {
        piupiu_regex: {
          scripts: [
            {
              id: 'r1',
              scriptName: '单引号变中文',
              findRegex: "'([^']*)'",
              replaceString: '‘$1’',
              disabled: false
            }
          ]
        }
      }
    })
    return id
  }

  it('体检材料带上世界书正文与正则脚本（审卡面板只看得到名字）', () => {
    const id = seedSickCard()
    const context = buildFullCardContext(id)!
    expect(context.lore.map((entry) => entry.name)).toContain('没人写的条目')
    expect(context.lore[0]!.content).toContain('入夜后任何人不得离开房间')
    expect(context.regexes[0]!.pattern).toBe("'([^']*)'")
    expect(context.regexes[0]!.replacement).toBe('‘$1’')

    const text = formatFullCardContext(context)
    expect(text).toContain('id=card:r1')
    expect(text).toContain('单引号变中文')
    expect(text).toContain('【正则脚本】')
    expect(text).toContain('（共 2 条）')
  })

  // 190 条的卡只带前 100 条进来：不写明总数，她会把「只看了一部分」当成「只有这些」，
  // 后半段的条目整片漏报
  it('世界书条目被截断时，材料里写明「共 N 条，只列了前 M 条」', () => {
    const id = seedSickCard()
    const context = buildFullCardContext(id)!
    const text = formatFullCardContext({ ...context, loreTotal: 190 })
    expect(text).toContain('共 190 条，以下列前 2 条')
  })

  it('体检走 JSON 模式，材料与规则一起发出去', async () => {
    const id = seedSickCard()
    ds.diagnosis = '{"issues":[]}'
    const issues = await diagnoseCard(id)
    expect(issues).toEqual([])
    expect(completes[0]!.jsonMode).toBe(true)
    // 必须关思考：大卡的材料有 59K token，开着的话推理 token 会把 max_tokens
    // 整个吃干净、content 是空串（实测 4000 / 8000 都能被吃光）
    expect(completes[0]!.disableThinking).toBe(true)
    const system = completes[0]!.messages[0]!.content
    expect(system).toContain('体检')
    expect(system).toContain('单引号变中文')
    expect(system).toContain('入夜后任何人不得离开房间')
  })

  it('解析出问题清单，修法不合规的降级成「只提示」', () => {
    const { issues } = parseDiagnosis(
      JSON.stringify({
        issues: [
          {
            severity: 'high',
            title: '正则会把脚本洗崩',
            detail: '单引号规则会打到 <script> 里',
            fix: { type: 'regex', ruleId: 'r1', patch: { enabled: false } }
          },
          {
            severity: 'low',
            title: '空条目',
            detail: '没人写的条目',
            fix: { type: 'regex', ruleId: 'r1', patch: { pattern: '(' } }
          }
        ]
      })
    )
    expect(issues).toHaveLength(2)
    expect(issues[0]!.fix).toEqual({ type: 'regex', ruleId: 'r1', patch: { enabled: false } })
    // 编译不过的正则整条拒掉，但问题本身仍然显示给用户
    expect(issues[1]!.fix).toBeNull()
    expect(issues[1]!.title).toBe('空条目')
  })

  it('结果被截断时抢救出完整的那几条', () => {
    const truncated =
      '{"issues":[{"severity":"high","title":"甲","detail":"x","fix":null},' +
      '{"severity":"high","title":"乙","detail":"y","fix":'
    const { issues } = parseDiagnosis(truncated)
    expect(issues.map((item) => item.title)).toEqual(['甲'])
  })

  // detail / replacement 里的花括号不是 JSON 结构：数花括号的抢救实现会把深度算歪，
  // 前面那条完整的问题被并进一段解析不了的切片里，悄无声息地少报一条
  it('字符串里的花括号不会打乱截断抢救', () => {
    const truncated =
      '{"issues":[{"severity":"high","title":"甲","detail":"把 } 换成别的","fix":null},' +
      '{"severity":"high","title":"乙","detail":"y","fix":null},' +
      '{"severity":"high","title":"丙","detail":"z","fix":'
    const { issues } = parseDiagnosis(truncated)
    expect(issues.map((item) => item.title)).toEqual(['甲', '乙'])
  })

  // 被 max_tokens 截断的 JSON 里 `"issues"` 一定在（只是数组没闭合）：拿它当「解析成功」的
  // 判据，会把一次一个完整对象都没抠到的体检报成「卡很干净」——这一条要红在「没解析出来」
  it('截断到一个完整问题都没有时算「没解析出来」，不算「卡很健康」', async () => {
    const id = seedSickCard()
    ds.diagnosis = '{"issues":[{"severity":"high","title":"正则会把脚本洗崩","detail":"单引号'
    expect(parseDiagnosis(ds.diagnosis)).toEqual({ issues: [], parsed: false })
    await expect(diagnoseCard(id)).rejects.toThrow('截断')
  })

  it('一个字都没解析出来时报错，不假装「卡很健康」', async () => {
    const id = seedSickCard()
    ds.diagnosis = '好的，我看完了。'
    await expect(diagnoseCard(id)).rejects.toThrow('截断')
  })

  // 推理 token 吃光预算时 content 就是空串：说成「被截断」会让用户一直重试同一个错，
  // 而真正的修法是关掉思考（diagnoseCard 已经关了，这里是兜底提示）
  it('模型一个字都没输出时，提示「没说话」而不是「被截断」', async () => {
    const id = seedSickCard()
    ds.diagnosis = ''
    await expect(diagnoseCard(id)).rejects.toThrow('一个字都没说出来')
  })

  it('修复能写回卡里：正则 / 世界书 / 平铺字段', () => {
    const id = seedSickCard()

    applyCardFix(id, { type: 'regex', ruleId: 'r1', patch: { enabled: false } })
    let rule = readCardRegexes(getCardData(id), { forEditing: true })[0]!
    expect(rule.enabled).toBe(false)

    const entryId = readCardEntries(getCardData(id), { includeEmpty: true })[0]!.id
    applyCardFix(id, {
      type: 'lore',
      entryId,
      patch: { content: '入夜后任何人不得离开房间，违者逐出山门。' }
    })
    expect(readCardEntries(getCardData(id))[0]!.content).toContain('违者逐出山门')

    applyCardFix(id, { type: 'field', field: 'description', value: '{{char}}是镇魔司的新任司主。' })
    expect(getCard(id)!.description).toContain('新任司主')
    // 改平铺字段不能把 data_json 冲掉
    expect(getCardData(id)!['character_book']).toBeTruthy()
    expect(readCardRegexes(getCardData(id), { forEditing: true })).toHaveLength(1)
    rule = readCardRegexes(getCardData(id), { forEditing: true })[0]!
    expect(rule.enabled).toBe(false)
  })

  it('删除也能按 id 找到：模型抄丢 card: 前缀照样删得掉', () => {
    const id = seedSickCard()
    applyCardFix(id, { type: 'regex', ruleId: 'r1', remove: true })
    expect(readCardRegexes(getCardData(id), { forEditing: true })).toHaveLength(0)

    const entryId = readCardEntries(getCardData(id), { includeEmpty: true })[0]!.id
    applyCardFix(id, { type: 'lore', entryId, remove: true })
    expect(readCardEntries(getCardData(id), { includeEmpty: true })).toHaveLength(1)
  })

  it('要删的对象已经不在了就明确报错，不假装「已修复」', () => {
    const id = seedSickCard()
    const before = JSON.stringify(getCardData(id))
    expect(() => applyCardFix(id, { type: 'regex', ruleId: 'card:999', remove: true })).toThrow('找不到那条正则')
    expect(() => applyCardFix(id, { type: 'lore', entryId: 'card:999', remove: true })).toThrow('找不到那条世界书')
    expect(JSON.stringify(getCardData(id))).toBe(before)
  })

  it('非法修复直接拒绝，卡一个字节都不动', () => {
    const id = seedSickCard()
    const before = JSON.stringify(getCardData(id))
    expect(() => applyCardFix(id, { type: 'field', field: 'name', value: 'x' })).toThrow()
    expect(() => applyCardFix(id, { type: 'regex', patch: { pattern: '(' } })).toThrow()
    expect(() => applyCardFix(id, { type: 'lore', patch: { content: '' } })).toThrow()
    expect(JSON.stringify(getCardData(id))).toBe(before)
  })
})

describe('系统提示词', () => {
  it('ask 与 idea 两套规则不同，但都带着同一份材料', () => {
    const { chatId } = seed()
    seedDossier(chatId)
    const context = buildObserveContext(chatId)!
    const ask = spectatorSystem(context, 'ask')
    const idea = spectatorSystem(context, 'idea')
    expect(ask).toContain('鲸鱼娘')
    expect(ask).toContain('旁观者的口吻')
    expect(ask).not.toContain('往下走的方向')
    expect(idea).toContain('往下走的方向')
    expect(ask).toContain('师父的旧伤')
    expect(idea).toContain('师父的旧伤')
  })
})
