// 状态栏 iframe 的「酒馆运行时」数据形状。
// 主进程负责产出（tavern/runtime.ts），渲染层负责注入（tavern/statusBridge.ts）——
// 类型放 shared，两边对同一份数据有同一个口径。

export interface RuntimeMessage {
  /** 楼层号，0 起（与酒馆的 message_id 同义） */
  message_id: number
  role: 'user' | 'assistant' | 'system'
  message: string
  name: string
}

export interface RuntimeLoreEntry {
  uid: string
  name: string
  keys: string[]
  keysecondary: string[]
  content: string
  enabled: boolean
  constant: boolean
  order: number
  /** 0 = 角色设定之前，1 = 之后，4 = 按深度注入 */
  position: number
}

export interface RuntimeSnapshot {
  charName: string
  userName: string
  messages: RuntimeMessage[]
  statData: Record<string, unknown>
  lorebook: { name: string; entries: RuntimeLoreEntry[] }
}
