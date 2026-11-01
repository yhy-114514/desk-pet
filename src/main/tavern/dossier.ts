// 剧情档案（用户侧叫「忆境典藏」，鲸鱼娘观战那一侧叫「观测档案」，同一份 schema 双用）。
// 纯逻辑：摘要器的 prompt、模型输出的容错解析、注入 prompt 前的格式化。
// 落库与调用见 summaryStore.ts。

export interface DossierRelation {
  char: string
  relation_to_player: string
  attitude: string
}

export interface Dossier {
  card_name: string
  world_brief: string
  player_character: string
  scene_now: string
  key_events: string[]
  open_threads: string[]
  char_relations: DossierRelation[]
  tone: string
  updated_at: string
}

/**
 * 摘要器的 system prompt。
 * 带上旧档案：每 N 条消息只喂「上次档案 + 之后的新消息」，不需要每轮重读整场对话；
 * 但要求把旧档案里的信息并进去，否则早先的剧情节点会在第二次摘要后失去。
 */
export function buildSummaryPrompt(today: string): string {
  return `你是一个剧情档案记录器。读下面的对话，输出一份剧情档案。

规则：
- 只输出 JSON 对象，不要任何解释或 markdown 围栏。
- 字段固定为：card_name（角色卡名）、world_brief（世界观与背景，两三句）、player_character（玩家角色当前的处境与身份）、scene_now（此刻的场景与正在发生什么）、key_events（最近 3-5 个剧情节点，每条一句话的数组）、open_threads（埋了未收的伏笔或未解决的冲突，数组）、char_relations（数组，每项 {char, relation_to_player, attitude}）、tone（整体文风与氛围，一句）、updated_at（当前日期）。
- 如果给了「旧档案」，把里面仍然有效的剧情节点并入 key_events、未收的伏笔并入 open_threads，不要因为这次对话没提到就丢掉。
- 每个字符串字段都要有内容；实在没有就写「无」，不要留空串。
- 今天是 ${today}。`
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '')
}

function relations(value: unknown): DossierRelation[] {
  if (!Array.isArray(value)) return []
  const result: DossierRelation[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const who = str(record['char'])
    if (!who) continue
    result.push({
      char: who,
      relation_to_player: str(record['relation_to_player']),
      attitude: str(record['attitude'])
    })
  }
  return result
}

/** 把模型返回的文本解析成档案；不是合法 JSON 对象时返回 null（调用方保留旧档案）。 */
export function parseDossier(raw: string): Dossier | null {
  if (!raw.trim()) return null
  // 容忍 ```json 围栏与前后说明文字
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const text = fenced ? fenced[1]! : raw
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  return {
    card_name: str(record['card_name']),
    world_brief: str(record['world_brief']),
    player_character: str(record['player_character']),
    scene_now: str(record['scene_now']),
    key_events: strList(record['key_events']),
    open_threads: strList(record['open_threads']),
    char_relations: relations(record['char_relations']),
    tone: str(record['tone']),
    updated_at: str(record['updated_at'])
  }
}

/** 档案里是否真有任何内容（模型只回了 `{}` 时不该算一条有效档案）。 */
export function hasContent(dossier: Dossier): boolean {
  return (
    Boolean(
      dossier.world_brief ||
        dossier.player_character ||
        dossier.scene_now ||
        dossier.tone
    ) ||
    dossier.key_events.length > 0 ||
    dossier.open_threads.length > 0 ||
    dossier.char_relations.length > 0
  )
}

/** 拼成注入 system 的文本；没有内容时返回空串。 */
export function formatDossier(dossier: Dossier): string {
  if (!hasContent(dossier)) return ''
  const lines: string[] = []
  if (dossier.world_brief) lines.push(`世界观：${dossier.world_brief}`)
  if (dossier.player_character) lines.push(`玩家处境：${dossier.player_character}`)
  if (dossier.scene_now) lines.push(`当前场景：${dossier.scene_now}`)
  if (dossier.key_events.length > 0) {
    lines.push(`剧情节点：\n${dossier.key_events.map((item) => `- ${item}`).join('\n')}`)
  }
  if (dossier.open_threads.length > 0) {
    lines.push(`未收的伏笔：\n${dossier.open_threads.map((item) => `- ${item}`).join('\n')}`)
  }
  if (dossier.char_relations.length > 0) {
    lines.push(
      `人物关系：\n${dossier.char_relations
        .map((item) => `- ${item.char}：${item.relation_to_player}${item.attitude ? `，${item.attitude}` : ''}`)
        .join('\n')}`
    )
  }
  if (dossier.tone) lines.push(`文风：${dossier.tone}`)
  return `【前情提要（更早剧情的档案，续写时保持一致，不要复述）】\n${lines.join('\n')}`
}
