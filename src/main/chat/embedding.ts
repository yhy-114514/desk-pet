// 阿里云百炼（DashScope）文本向量：记忆的语义检索用它把「换种说法」也能对上号。
// 走 OpenAI 兼容模式（POST /compatible-mode/v1/embeddings），与 TTS / ASR 共用百炼 Key。
// 选云端而不是本地 ONNX 模型：本地模型要带 100MB+ 权重、冷启动几秒，装进桌宠不值当；
// 百炼按 token 计费（几分钱一百万字），一次查询一条短句，成本可以忽略。
export const EMBEDDING_MODEL = 'text-embedding-v4'

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings'

/** 一次请求最多 10 条，超过直接 400 `batch size is invalid`（2026-10-24 实测）。 */
export const EMBEDDING_BATCH = 10

const DEFAULT_TIMEOUT_MS = 15_000

interface EmbeddingRow {
  index?: number
  embedding?: unknown
}

function readEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return value as number[]
}

/**
 * 把若干段文本转成向量，返回顺序与入参一致。
 * 失败直接抛（带状态码与响应原文）：检索是可选增强，调用方要靠这个决定退回关键词。
 */
export async function embedTexts(
  texts: string[],
  key: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<number[][]> {
  const result: number[][] = []
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH) {
    result.push(...(await embedChunk(texts.slice(i, i + EMBEDDING_BATCH), key, timeoutMs)))
  }
  return result
}

async function embedChunk(texts: string[], key: string, timeoutMs: number): Promise<number[][]> {
  if (texts.length === 0) return []

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
        encoding_format: 'float'
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      // 401 = Key 错、404 = 模型不在账号里。原文必须带上，否则只会表现为「检索不准了」
      console.warn(`[embedding] 向量化失败 ${response.status}: ${detail.slice(0, 300)}`)
      throw new Error(
        `向量化失败（${response.status}）${detail ? `：${detail.slice(0, 160)}` : ''}`
      )
    }

    const json = (await response.json()) as { data?: EmbeddingRow[] }
    const rows = Array.isArray(json.data) ? [...json.data] : []
    if (rows.length !== texts.length) {
      throw new Error(`向量条数不对：请求 ${texts.length} 条，返回 ${rows.length} 条`)
    }

    // 批量返回的 index 是请求内的序号，不保证顺序，按它排回来。
    // 只要有一行给了 index 就必须全部给全且从 0 连续——否则「按 index 排」等于不排，
    // 向量会被错配到别的记忆名下，而且从结果上完全看不出来（静默的错位最麻烦）。
    // 一行都没给时（兼容实现）按返回顺序使用，OpenAI 规范就是这样约定的。
    if (rows.some((row) => row.index !== undefined)) {
      if (!rows.every((row) => Number.isInteger(row.index))) {
        throw new Error('返回的向量缺少序号，无法与输入对齐')
      }
      rows.sort((a, b) => (a.index as number) - (b.index as number))
      if (rows.some((row, i) => row.index !== i)) {
        throw new Error('返回的向量序号不连续，无法与输入对齐')
      }
    }

    return rows.map((row) => {
      const embedding = readEmbedding(row.embedding)
      if (!embedding) throw new Error('返回的向量格式不对')
      return embedding
    })
  } catch (error) {
    // fetch 的中止错误原文是英文对象名，日志里看不出是「等太久」
    if (error instanceof Error && error.name === 'AbortError') throw new Error('向量化超时')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
