// DeepSeek 客户端（OpenAI 兼容格式，SSE 流式）。运行在主进程，API Key 不外泄。
// 用 Node 内置 fetch 读取 response.body，手动按 SSE 事件切分，不引入第三方依赖。
import { MAX_TOKENS, TEMPERATURE } from './persona'
import type { ChatMessage } from './session'

const API_URL = 'https://api.deepseek.com/chat/completions'

export interface StreamOptions {
  messages: ChatMessage[]
  apiKey: string
  model: string
  signal?: AbortSignal
  /** 不传就用鲸鱼娘人设里的值；酒馆有自己的采样参数 */
  temperature?: number
  maxTokens?: number
  onToken: (delta: string) => void
}

export interface SSEParseResult {
  /** 本次解析出的增量文本 */
  deltas: string[]
  /** 是否收到 [DONE] */
  done: boolean
  /** 尚未组成完整事件的残余（拼接到下次解析） */
  rest: string
}

/**
 * 解析一段 SSE 文本：按空行切成完整事件，逐个取 `data:` 行。
 * 不完整的事件留在 rest 里等下一块数据；坏 JSON 直接跳过，避免半个包把整轮打断。
 */
export function parseSSEChunk(buffer: string): SSEParseResult {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  const deltas: string[] = []
  let done = false

  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        done = true
        continue
      }
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[]
        }
        const content = json.choices?.[0]?.delta?.content
        if (typeof content === 'string' && content.length > 0) deltas.push(content)
      } catch {
        // 半截事件 / 非 JSON 行，忽略
      }
    }
  }

  return { deltas, done, rest }
}

export interface CompleteOptions {
  messages: ChatMessage[]
  apiKey: string
  model: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** 让接口强制输出合法 JSON（`response_format: json_object`）。变量补抽用它，
   *  比「让模型在自由文本里吐 JSON Patch、再靠正则抠」可靠得多。 */
  jsonMode?: boolean
  /**
   * 关掉模型的「思考」阶段（`thinking: {type:'disabled'}`）。
   *
   * 推理 token 和正文**共用** `max_tokens`：材料一大，模型会把整个预算耗在思考上，
   * `completion_tokens` 全是 `reasoning_tokens`、`content` 是空串（实测 4000 和 8000
   * 都能被吃干净，27~48 秒一个字都不出）。结构化任务（体检这种「读完照格式输出」）
   * 本来就没什么可推理的，关掉之后同样输入 5.8 秒出结果。
   */
  disableThinking?: boolean
}

/**
 * 非流式请求，返回完整回复文本。
 * 用于记忆抽取这类后台任务：不需要逐字展示，一次拿全更省事。
 */
export async function completeChat(opts: CompleteOptions): Promise<string> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: false,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 400,
      // JSON 模式：API 保证 content 是合法 JSON，解析不再靠猜
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(opts.disableThinking ? { thinking: { type: 'disabled' } } : {})
    }),
    signal: opts.signal
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`DeepSeek 请求失败（${response.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`)
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  return json.choices?.[0]?.message?.content ?? ''
}

/** 发起流式请求，逐块回调 onToken，返回完整回复文本。 */
export async function streamChat(opts: StreamOptions): Promise<string> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${opts.apiKey}`
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      temperature: opts.temperature ?? TEMPERATURE,
      max_tokens: opts.maxTokens ?? MAX_TOKENS
    }),
    signal: opts.signal
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`DeepSeek 请求失败（${response.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`)
  }
  if (!response.body) throw new Error('DeepSeek 返回空响应体')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parsed = parseSSEChunk(buffer)
    buffer = parsed.rest
    for (const delta of parsed.deltas) {
      full += delta
      opts.onToken(delta)
    }
    if (parsed.done) break
  }

  return full
}
