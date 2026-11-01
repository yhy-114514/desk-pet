// 剧情档案（忆境典藏）：模型输出的容错解析与注入前的格式化。
import { describe, expect, it } from 'vitest'
import { formatDossier, hasContent, parseDossier } from './dossier'

const full = {
  card_name: '苏月珑',
  world_brief: '仙洲历三千年，月珑峰常年积雪。',
  player_character: '刚入门的外门弟子。',
  scene_now: '清晨的练剑场。',
  key_events: ['拜师', '第一次筑基失败'],
  open_threads: ['断水剑的来历'],
  char_relations: [{ char: '苏月珑', relation_to_player: '师父', attitude: '清冷但护短' }],
  tone: '清淡的古风',
  updated_at: '2026-10-25'
}

describe('parseDossier', () => {
  it('原样解析完整档案', () => {
    expect(parseDossier(JSON.stringify(full))).toEqual(full)
  })

  it('容忍 ```json 围栏与前后说明文字', () => {
    const raw = `好的，档案如下：\n\`\`\`json\n${JSON.stringify(full)}\n\`\`\`\n以上就是。`
    expect(parseDossier(raw)?.scene_now).toBe('清晨的练剑场。')
  })

  it('缺字段按空值补齐，非字符串数组项被丢掉', () => {
    const dossier = parseDossier('{"key_events":["拜师",3,null,{"a":1}],"char_relations":[{"char":""}]}')
    expect(dossier?.key_events).toEqual(['拜师'])
    expect(dossier?.char_relations).toEqual([])
    expect(dossier?.world_brief).toBe('')
  })

  it('不是合法 JSON 对象时返回 null（调用方保留旧档案）', () => {
    expect(parseDossier('我看不懂这句话')).toBeNull()
    expect(parseDossier('[]')).toBeNull()
    expect(parseDossier('')).toBeNull()
  })
})

describe('formatDossier', () => {
  it('全空档案不注入', () => {
    const dossier = parseDossier('{}')!
    expect(hasContent(dossier)).toBe(false)
    expect(formatDossier(dossier)).toBe('')
  })

  it('只拼有内容的字段', () => {
    const dossier = parseDossier(JSON.stringify({ ...full, char_relations: [], tone: '' }))!
    const text = formatDossier(dossier)
    expect(text).toContain('世界观：')
    expect(text).toContain('剧情节点：\n- 拜师\n- 第一次筑基失败')
    expect(text).toContain('未收的伏笔：')
    expect(text).not.toContain('人物关系')
    expect(text).not.toContain('文风')
  })
})
