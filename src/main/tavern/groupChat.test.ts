// 群聊：消息里的「名字：」怎么认、@ 谁必回、轮换兜底、提示词装配、打分解析。
import { describe, expect, it } from 'vitest'
import {
  fallbackSpeaker,
  GROUP_SCORE_THRESHOLD,
  MAX_GROUP_SPEAKERS,
  parseSpeaker,
  pickNamedSpeakers,
  stripSpeakerPrefix
} from '../../shared/groupChat'
import { buildGroupPrompt, buildGroupSystem, buildScoreMessages, parseScores } from './groupChat'

const names = ['阿蕾', '小满', '海边']

describe('parseSpeaker', () => {
  it('认出成员前缀，正文只留说的话', () => {
    expect(parseSpeaker('阿蕾：你来了。', names)).toEqual({ speaker: '阿蕾', text: '你来了。' })
    expect(parseSpeaker('小满: 好呀', names)).toEqual({ speaker: '小满', text: '好呀' })
  })

  it('不是成员的名字、或者正文第一句里有冒号，都当没有前缀', () => {
    expect(parseSpeaker('旁白：天黑了', names)).toEqual({ speaker: null, text: '旁白：天黑了' })
    expect(parseSpeaker('他说：别走', names)).toEqual({ speaker: null, text: '他说：别走' })
  })

  it('没有冒号就是完整正文', () => {
    expect(parseSpeaker('她笑了一下。', names)).toEqual({ speaker: null, text: '她笑了一下。' })
  })
})

describe('stripSpeakerPrefix', () => {
  it('流式里名字被拆成两半时先扣住，不先吐一个「阿」', () => {
    expect(stripSpeakerPrefix('阿', names)).toBe('')
    expect(stripSpeakerPrefix('阿蕾', names)).toBe('')
    expect(stripSpeakerPrefix('阿蕾：', names)).toBe('')
    expect(stripSpeakerPrefix('阿蕾：你来了', names)).toBe('你来了')
  })

  it('正文照常放过，不吞不是名字开头的内容', () => {
    expect(stripSpeakerPrefix('你来了', names)).toBe('你来了')
  })
})

describe('pickNamedSpeakers', () => {
  it('@ 过的名字必回，按在文本里出现的先后排', () => {
    expect(pickNamedSpeakers('@小满 你怎么看？@阿蕾', names)).toEqual(['小满', '阿蕾'])
    expect(pickNamedSpeakers('＠阿蕾 早', names)).toEqual(['阿蕾'])
  })

  it('没 @ 就是空的；@ 再多也只回两个', () => {
    expect(pickNamedSpeakers('大家早', names)).toEqual([])
    expect(pickNamedSpeakers('@阿蕾 @小满 @海边', names)).toHaveLength(MAX_GROUP_SPEAKERS)
  })

  it('名字之间的包含关系不会误伤（阿蕾 / 阿蕾蕾）', () => {
    expect(pickNamedSpeakers('@阿蕾蕾 在吗', ['阿蕾', '阿蕾蕾'])).toEqual(['阿蕾蕾'])
  })
})

describe('fallbackSpeaker', () => {
  it('按轮数轮流，保证总有人接话', () => {
    expect(fallbackSpeaker(names, 0)).toBe('阿蕾')
    expect(fallbackSpeaker(names, 4)).toBe('小满')
    expect(fallbackSpeaker([], 1)).toBeNull()
  })

  it('阈值就是「过线才接话」的那条', () => {
    expect(GROUP_SCORE_THRESHOLD).toBeGreaterThan(0)
    expect(GROUP_SCORE_THRESHOLD).toBeLessThan(1)
  })
})

const members = [
  {
    id: 'a',
    name: '阿蕾',
    avatarPath: null,
    description: '住在海边小镇的姑娘。',
    personality: '温柔',
    scenario: '傍晚的海堤'
  },
  {
    id: 'b',
    name: '小满',
    avatarPath: null,
    description: '',
    personality: '爱闹',
    scenario: ''
  }
]

const profile = { name: '哥哥', description: '每天下班都会来镇上。' }

describe('buildGroupSystem', () => {
  it('点名本轮发言人，成员设定和玩家设定都在', () => {
    const text = buildGroupSystem({
      groupName: '海堤夜话',
      members,
      profile,
      speaker: '小满',
      lore: []
    })
    expect(text).toContain('「海堤夜话」')
    expect(text).toContain('只扮演「小满」')
    expect(text).not.toContain('{speaker}')
    expect(text).toContain('【阿蕾】')
    expect(text).toContain('性格：爱闹')
    expect(text).toContain('哥哥')
  })

  it('玩家没写设定时说清楚，不塞空段落', () => {
    const text = buildGroupSystem({
      groupName: 'g',
      members,
      profile: { name: '哥哥', description: '' },
      speaker: '阿蕾',
      lore: []
    })
    expect(text).toContain('（玩家没有写设定）')
  })

  it('成员 / 玩家设定里的 {{char}}、{{user}} 换成真名，不把字面量发给模型', () => {
    const text = buildGroupSystem({
      groupName: 'g',
      members: [{ ...members[0]!, description: '{{user}}是{{char}}的学生。' }, members[1]!],
      profile: { name: '哥哥', description: '{{char}}的哥哥。' },
      speaker: '阿蕾',
      lore: []
    })
    expect(text).toContain('哥哥是阿蕾的学生。')
    expect(text).toContain('阿蕾的哥哥。')
    expect(text).not.toContain('{{')
  })

  it('激活的世界书与文风接在后面', () => {
    const text = buildGroupSystem({
      groupName: 'g',
      members,
      profile,
      speaker: '阿蕾',
      lore: [
        {
          id: 'l1',
          name: '海堤',
          content: '海堤尽头有一座旧灯塔。',
          keys: [],
          secondaryKeys: [],
          constant: true,
          selective: false,
          position: 'before_char',
          depth: 4,
          order: 100,
          caseSensitive: false,
          source: 'global',
          readonly: false
        }
      ],
      styleText: '文风：短句。'
    })
    expect(text).toContain('【世界设定】')
    expect(text).toContain('旧灯塔')
    expect(text.indexOf('旧灯塔')).toBeLessThan(text.indexOf('文风：短句。'))
  })
})

describe('buildGroupPrompt', () => {
  it('system 在最前，历史在后，本轮输入最后', () => {
    const messages = buildGroupPrompt({
      system: 'SYS',
      history: [
        { role: 'assistant', content: '阿蕾：你来了。' },
        { role: 'user', content: '嗯。' },
        { role: 'assistant', content: '   ' }
      ],
      userText: '今天吃什么？'
    })
    expect(messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(messages.map((item) => item.content)).toEqual(['SYS', '阿蕾：你来了。', '嗯。', '今天吃什么？'])
  })

  it('没有本轮输入（重生成）就不追加空 user', () => {
    const messages = buildGroupPrompt({
      system: 'SYS',
      history: [{ role: 'assistant', content: '阿蕾：你来了。' }],
      userText: ''
    })
    expect(messages.every((item) => item.content.trim() !== '')).toBe(true)
    expect(messages).toHaveLength(2)
  })
})

describe('buildScoreMessages / parseScores', () => {
  it('打分请求带着成员名和最近几轮对话', () => {
    const messages = buildScoreMessages(['阿蕾', '小满'], ['阿蕾：你来了。'], '去海边吗？')
    expect(messages[0]!.content).toContain('阿蕾、小满')
    expect(messages[1]!.content).toContain('去海边吗？')
    expect(messages).toHaveLength(2)
  })

  it('解析对象外壳 / 裸对象 / 非法 JSON 的逐个抠', () => {
    expect(parseScores('{"scores":{"阿蕾":0.9,"小满":0.2}}', ['阿蕾', '小满'])).toEqual({
      阿蕾: 0.9,
      小满: 0.2
    })
    expect(parseScores('{"阿蕾":0.6}', ['阿蕾'])).toEqual({ 阿蕾: 0.6 })
    expect(parseScores('阿蕾: 0.8，小满: 0.1', ['阿蕾', '小满'])).toEqual({ 阿蕾: 0.8, 小满: 0.1 })
    expect(parseScores('', ['阿蕾'])).toBeNull()
    expect(parseScores('不知道', ['阿蕾'])).toBeNull()
  })

  it('只留数字，别的键（解释 / 多余字段）丢掉', () => {
    expect(parseScores('{"scores":{"阿蕾":0.7,"备注":"随便聊聊"}}', ['阿蕾'])).toEqual({ 阿蕾: 0.7 })
  })
})
