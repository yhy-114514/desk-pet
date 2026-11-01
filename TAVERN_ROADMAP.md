# TAVERN_ROADMAP — 酒馆模块全量开发路线

> 更新于 2026-10-25。本文件是「鲸鱼娘桌宠 + 酒馆」一体化的执行总纲，替代并修正仓库根目录的
> `pet_bar_insight.md`（v2）。insight 是「从零建一个全新 app」的设想稿，与实际已验收代码差异较大；
> **本文件以现有代码为准**，把原 12 阶段压成下面的 T0–T9，去掉已完成项与不做的项。
>
> 上一棒：P0–P6 + 阶段 E 第 1–7 项全部通过人工验收（2026-10-24，299 例测试全绿，见 `CLAUDE.md` §〇）。
> 本文件只讲**新增的酒馆模块**；与桌宠重叠的部分一律「复用不重做」。

---

## 一、现状基线（开工前必读）

### 1.1 技术栈的真相

`pet_bar_insight.md` 写的是「Electron + Vite + **Vue 3** + TypeScript + **better-sqlite3**」。
实际代码是：

| 层 | insight 设想 | **实际（已验收）** |
|---|---|---|
| 框架 | Electron + Vite + Vue 3 | Electron + **electron-vite**（无 Vue/React） |
| 渲染 | Vue 组件 | **PixiJS v8**（桌宠）+ **纯 DOM**（`#config`/`#memory`/`#reminders` 等小窗） |
| 存储 | better-sqlite3 | **手写 JSON**（`userData/*.json`，原子写 tmp+rename） |
| 路由 | Vue Router | **单 `index.html` + hash**（`#dashboard`/`#chat-input`/`#config`/`#memory`/`#reminders`） |
| 窗口 | 主窗口 + tab | 主进程按 hash 建 6 种 `BrowserWindow` |

### 1.2 聊天子系统是「单角色写死」（决定改造范围）

探索确认的硬事实：

- `src/main/chat/persona.ts`：`SYSTEM_PROMPT` 是鲸鱼娘人设字符串常量；`session.ts:5` 直接 `import`
  并在 `buildMessages()` 里拼成 `messages[0]`。**没有**任何「传入不同 system prompt」的入口。
- `src/main/chat/ipc.ts:24`：`const session = new ChatSession()` 是**全局单例**，全应用只有一条会话。
- `memory.json` / `chat-history.json` / `config.json` / `memory-vectors.json` / `reminders.json`
  / `proactive.json` **全是单槽文件，没有任何 `character` / `chat` 维度**。
- 渲染层没有「消息列表 / 多轮对话视图」——气泡只有 `chatBubble.ts`（PixiJS、单气泡、挂在她头顶）。

### 1.3 能原样复用（零改动或极薄封装）

| 能力 | 文件 | 复用方式 |
|---|---|---|
| LLM 客户端 | `chat/deepseek.ts` | `streamChat(opts)` / `completeChat(opts)` 全是泛型入参（messages/model/key），**直接调用** |
| 朗读合成 | `chat/tts.ts`、`chat/speech.ts`、`chat/speechStreamer.ts` | 传入文本 + 音色，**直接调用** |
| 情绪标记解析 | `chat/emotion.ts` | 纯逻辑，可给角色卡回复复用 |
| 提醒标记解析 | `chat/reminder.ts` | 纯逻辑，可复用 |
| Embedding | `chat/embedding.ts` | `text-embedding-v4` 客户端，**直接调用** |
| 记忆中关键词检索 / 余弦打分 | `chat/memory.ts`（`searchMemories*`、bigram） | 纯算法，可移植到酒馆记忆表 |
| token 估算 / 时钟注入 | `chat/session.ts` 的 `estimateTokens` / `withClock` | 纯函数，直接 import |
| 好感度 | `renderer/src/affection.ts` | 纯逻辑（酒馆不需要，桌宠的已在用） |
| 主动消息调度 | `chat/proactive.ts` + `main/proactive.ts` | 桌宠专用，酒馆观战可借「轮次触发」思路 |
| 语音播放/录制 | `renderer/src/voicePlayer.ts` / `voiceRecorder.ts` | 直接复用 |
| 窗口位置 / 多屏 | `main/windowPlacement.ts` / `windowState.ts` | 酒馆窗口沿用 |
| 打包发布 | `electron-builder.yml` | 沿用（但 native 模块见「七、风险」） |

### 1.4 一句话定位

**鲸鱼娘是核心（已建好，不动）；酒馆是旁支的新窗口（新模块），鲸鱼娘既是「隔壁的朋友」也是「观战者」。**
不是把桌宠重做成酒馆，也不是把鲸鱼娘塞进酒馆当一张卡。

---

## 二、对 `pet_bar_insight.md` 的修正（逐条）

> 这是本次最重要的产出之一。insight 并非全错，但下面 8 处必须按现实改写，否则会误导实现。

| # | insight 原文 / 假设 | 问题 | **修正** |
|---|---|---|---|
| 1 | 技术栈「Vue 3 + better-sqlite3」 | 现有代码无 Vue、无 SQLite；引入 Vue 等于重写已验收的 P0–P6 | **不引入 Vue**。SQLite 只给酒馆数据层用，鲸鱼娘 JSON 保持不动（用户拍板） |
| 2 | 阶段 8「桌宠本体（3~4 天）」要建宠物 | 宠物、动画、互动、托盘、自启、多屏**已完成验收**（P0–P6） | 本阶段砍到只剩「双击开酒馆 + 观战状态」联动 |
| 3 | 阶段 8「语音设置页（仅朗读对话/自动播放/音色/音量/语速/试听）」 | 语音朗读、音色（Edge/千问双套）、朗读开关**已在现有配置窗落地** | 不重复开发；酒馆若要「每角色独立音色」才是新增 |
| 4 | 阶段 1「账号与邀请系统（唯一需要服务端）」 | 需自建服务端；且与附录「全免费是差异化」自相矛盾 | **整体砍掉**。用户人设降级为本地 profile（见 T1） |
| 5 | 「桌宠渲染：Live2D → 自研接入层」 | 实际是**序列帧 sprite + PixiJS**（31 组 atlas） | 表述对齐即可，无需新建；沿用 `animator.ts` / `assets/manifest.json` |
| 6 | 阶段 4「永久记忆 / 忆境典藏 / 回忆视界」 | 与现有鲸鱼娘单槽记忆（`memory.json`+向量）是**两套东西**；insight 的是 per-角色/per-会话 | 酒馆记忆在 SQLite 新建 `memories`/`chat_summaries` 表；鲸鱼娘自己的记忆**不动** |
| 7 | 阶段 0「底部导航五 tab：角色 / 回忆 /（发布）/ 连接 / 设置」 | 「连接」tab 是给账号/社交预留的，砍掉后悬空 | 重排：**角色 / 回忆 /（发布 FAB）/ 设置**（4 项），「连接」不做 |
| 8 | 阶段 0「主窗口（酒馆）+ 底部导航」= app 主体 | 实际宠物是主窗口、酒馆是第二窗口 | 酒馆是**独立 `BrowserWindow`（`#tavern`）**，不是替换主窗口 |
| 9 | 全局规范「UI 文案全部走 i18n 文案文件」 | 现有项目**没有任何 i18n**，全是硬编码中文；单语言个人项目引入 i18n 是过度工程 | **不做 i18n**，酒馆沿用硬编码中文；世界术语（御言篇幅等）直接写进 UI 文案 |

另有两处**方向正确但需确认**：

- Insight「所有外部服务走抽象接口（`LLMProvider`/`ImageProvider`/`EmbedProvider`）」——方向对，但
  现有 `deepseek.ts` / `embedding.ts` / `tts.qwenTts` 已是「一函数一能力」的薄封装，**不必为抽象而抽象**。
  只在 T6（配图）真正接入第二家生图 API 时再做 `ImageProvider` 抽象接口。
- Insight「异步批处理走后台队列、单并发、失败重试 2 次」——现有 `memoryStore.extractMemories`
  是 fire-and-forget 静默失败；酒馆摘要（T3）照此思路做轻量队列即可，不引入队列库。

---

## 三、总体架构决策

### 3.1 存储分层（用户拍板）

```
userData/
├── *.json                    ← 鲸鱼娘专属，保持现状（config / chat-history / memory /
│                                memory-vectors / reminders / proactive / window / pet-store）
└── tavern.db (SQLite)        ← 酒馆全部数据：角色卡 / 会话 / 消息树 / 世界书 / 正则 /
                                 预设 / 状态栏 / 记忆 / 摘要 / 设置 / 群聊
```

- **为什么不把鲸鱼娘也迁进 SQLite**：现有 8 个 JSON 已在生产验收，迁移纯属自找风险（丢数据）。
- **为什么酒馆用 SQLite**：多角色 + 消息树（`parent_id` 分支） + 全文搜索 + 大量消息，JSON 会撑爆。
- **鲸鱼娘读酒馆数据**：**主进程**内直接查 `tavern.db`（同一进程、同一模块）只读，拼成文本后走
  **一次性 messages**（或独立的 `ChatSession` 实例）回答——**不塞进主单例的 `session.setSystemContext()`**，
  否则会污染她的日常聊天。**不经渲染层、不新开通道**（见 T7）。

### 3.2 进程与 IPC 划分（沿用现有约定）

- 主进程：SQLite 读写、文件、LLM/Embedding/生图代理。**所有 Key 不出主进程。**
- 渲染进程：`#tavern` 纯 DOM 页面 + 复用 `voicePlayer`。**禁止直连外部 API。**
- IPC 前缀：沿用 `tavern:`（新模块统一前缀），`window.tavern` 由 `preload/index.ts` 暴露。
  **记得同时把 `tavern:` 补进 `CLAUDE.md` §四.4 的通道前缀约定**（否则违反项目契约）。
- **LLM 配置复用**：酒馆的 `apiKey` / `model` 直接读 `chat/config.ts` 的 `loadConfig()`（同一个 DeepSeek
  Key），不另建配置文件；生图 Key（T6）才单独加。
- **朗读（TTS）**：做成**用户可在设置里开关**的项（默认关，见 T5），复用现有 TTS；「每角色音色映射」
  属于加分项、后置。T2 的验收不含朗读。

### 3.3 渲染层不引入框架

`#tavern` 用**纯 DOM 拼装**（与 `memoryPage.ts` / `reminderPage.ts` 一致）。理由：项目现有零框架、
`electron.ev` 单 HTML 入口；引入 Vue 是重写风险。若后续 UI 复杂度不可控，再单独评估，但**默认不做**。

### 3.4 酒馆**不复用** `ChatSession`，`session.ts` 保持不动

初版曾计划把 `ChatSession` 的 `SYSTEM_PROMPT` 参数化后给酒馆复用，**读过完整实现后判定这是错的**：

- `ChatSession` 维护的是**线性内存历史**（`pushUser` / `pushAssistant` / `restore`），而酒馆的真相源是
  DB 里的**消息树**（`parent_id` 分支）。两者双写必然出现「内存态 ≠ DB 态」，切换分支 / 重生成时极易错乱。
- 这个类整体带鲸鱼娘专属语义：第四面墙彩蛋、30 轮冷却、`MAX_TURNS=20` / `HISTORY_MAX_TOKENS=4000` 固定裁剪、
  `restore()` 只接受 user/assistant 线性数组。硬套给酒馆只会把不匹配的模型拽进来。

**正确做法**：酒馆的 `promptBuilder.ts` 直接从消息树算出 `messages` 数组（纯函数、可单测），
只复用 `session.ts` 里两个纯函数：

- `estimateTokens(text)` —— token 估算（CJK 1 字 1 token）；
- `trimHistory` 的裁剪**思路**（酒馆按角色卡体量另设预算，不复用 4000 的固定值）。

**因此 `session.ts` / `persona.ts` / `ipc.ts` 一行都不用改**——比初版计划的改造面更小，也更符合
「鲸鱼娘已验收、不碰」的原则。

### 3.5 设计语言与差异化（参考 `piupiu/` 截图，不照搬）

`piupiu/` 里 23 张截图是 **UI 参考，不是要 1:1 复刻**，也不打包进 app。它们真正有价值的是**信息架构**
（分组玻璃卡片、底部导航 + 中央 FAB、聊天页小说流、聊天选项宫格），这套结构经过验证、易理解，**直接采纳**。
视觉与交互上，以下几处是**已确认的取向**（2026-10-25 用户选定 **「深海夜航」主题** + **「响应式三栏」布局**）：

1. **主题用「深海夜航」而不是通用粉紫**：以鲸鱼娘的世界为基调——深蓝紫底、生物荧光青作「可交互」高亮、
   珊瑚粉作强调色；黑夜模式即默认，浅色为可选。这样酒馆和桌宠像**同一个世界**，而不是两个 app 拼在一起。
   即：**用 PiuPiu酱 证明过的结构，换掉它的皮肤**。
2. **桌面优先的三栏布局（核心差异）**：手机 app 是「底部 tab + 单列」，桌面有宽屏，不该照抄。
   - 宽窗：左栏=角色 / 会话列表，中栏=小说流阅读，右栏=可收起的**鲸鱼娘观战抽屉**；
   - 窄窗（< 720px）：自动退回「底部 tab + 单列」，与截图一致（响应式，不是二选一）。
   这是桌面相对手机的天然优势，也是「旁观者」卖点最好的载体。
3. **沉浸阅读模式**：小说流三色 + 可调排版（行距 / 字距 / 最大阅读宽度 / 首行缩进），并提供「沉浸」开关，
   隐藏顶栏与输入栏只留文字。截图没有，但阅读类产品这是刚需。
4. **消息树可视化**：截图的聊天是线性的；我们要做分支（`parent_id`）。用「书签节点」在消息旁标出分叉，
   点开可切分支，不破坏阅读流。
5. **观战抽屉是独有面**：她以旁白口吻在右侧给灵感 / 吐槽，默认收起、问才答，绝不打断正文对话。

不做：`piupiu/` 里的会员 / SVIP 标签、充值、账号相关视觉（功能已砍）。

---

## 四、数据模型（SQLite 草案，T0 建库时定稿）

> 字段来自 insight 阶段 2–6，按 SQLite 规范化整理；只列关键字段，完整 DDL 在 `migrations/000_init.sql`。

```
characters      (id PK, name, description, personality, scenario, first_mes,
                 alternate_greetings JSON, mes_example, system_prompt,
                 post_history_instructions, creator, tags JSON, avatar_path,
                 creator_notes, data_json TEXT,      ← 整份 ST data 原样
                 created_at, updated_at, deleted_at)

chats           (id PK, character_id FK, title, preset_id FK NULL,
                 is_group INTEGER, settings JSON, created_at, updated_at, deleted_at)

messages        (id PK, chat_id FK, parent_id FK NULL, branch_index INTEGER,
                 role TEXT, content TEXT, is_deleted INTEGER, token_count,
                 created_at)                      ← 从第一天就建树

chat_summaries  (id PK, chat_id FK, from_message_id, to_message_id,
                 dossier JSON, created_at)        ← 阶段4「忆境典藏」，双用 schema

memories        (id PK, scope TEXT, character_id NULL, chat_id NULL,
                 type, content, created_at, updated_at)   ← 阶段4「永久记忆」

memory_vectors  (memory_id PK, h TEXT, v BLOB)     ← 或用 JSON 文本列

lorebooks / lorebook_entries                     ← 阶段5 世界书（三层：global/character/chat）
regexes                                          ← 阶段5 正则
presets / preset_entries                         ← 阶段5 预设
status_bars / status_items                       ← 阶段5 状态栏
settings        (key PK, value JSON)             ← 阶段6 外观/通用（黑夜模式等）
```

> **`data_json` 是保真的关键（2026-10-25 补）**：卡里绝大多数内容不在那 12 个平铺字段里，而在
> `data.character_book`（世界书）、`data.extensions`（正则 / 脚本 / 深度注入）、`data.group_only_greetings`
> （群聊开场白）里。这些字段编辑页不管，所以必须整份原样存下来——否则「导入成品卡 → 编辑一下 → 导出」
> 得到的是一张丢了世界书的残卡。

术语映射（insight 附录用词，代码里可沿用英文名）：

| 产品术语 | 表 / 字段 |
|---|---|
| 御言篇幅 | `settings` 里的 `reply.minChars` / `reply.maxChars` |
| 忆境典藏 | `chat_summaries.dossier` |
| 观测档案 | 同 `chat_summaries.dossier`（鲸鱼娘侧叫法） |
| 回忆视界 | `settings` 的 `memory.viewDepth` / `fullView` |
| 永久记忆 | `memories`（type: preference/event/promise/identity/fact/other） |

---

### 四·二 真实角色卡 / 预设长什么样（2026-10-25 从成品反推，务必按这个理解）

> 分析样本：`piupiu/card_comprehension/` 的两张成品 PNG（单角色「我的白毛萝莉师父·苏月珑」、
> 多角色「宝可梦-战斗10.0」）+ 一个全局预设（「双人成行—GPT破限版」，236 条 prompt）。
> 分析只做理解与对齐，样本不进仓库、不入安装包。

**一张 ST v2 卡的组成部分**

| 组成部分 | 说明 |
|---|---|
| `description` | 通常不是一段散文，而是**结构化人设块**（核心身份 / 背景 / 外貌 / 性格 / 能力 / 表达方式 / 关系） |
| `personality` / `scenario` | 可空；`description` 写全了就留空 |
| `first_mes` / `alternate_greetings` | 开场白与备选 |
| `group_only_greetings` | **群聊专属开场白**（群聊时才用，不要与 `first_mes` 混） |
| `mes_example` | 对话示例（few-shot，教模型说话方式） |
| `system_prompt` / `post_history_instructions` | 系统提示 / 历史之后的指令 |
| **`character_book`** | **世界书**（内嵌在卡里）：每条含 `keys` 触发词、`position`（before_char / after_char）、`constant` 常驻、`selective`、`insertion_order`、`content` |
| **`extensions`** | `piupiu_regex` / `regex_scripts`（正则替换）、`depth_prompt`（深度注入 / 思维链）、`TavernHelper_scripts`（自定义脚本） |
| `creator` / `creator_notes` / `character_version` / `tags` | 元信息 |

**单角色卡 vs 多角色卡**

- 单角色卡：`description` 是一整段人设；`character_book` 放背景设定 + 玩家角色 + 变量系统规则。
- 多角色卡：`description` 往往只有一句「{{char}} 是一个开放世界场景」；**几乎全部内容在 `character_book`
  的几十上百条里**（世界规则 `constant` 常驻、地区 / 组织 / 角色档案 / 剧本按 `keys` 条件加载）。
  这类卡本质是「卡 = 一个世界 / 剧本，AI 当跑团 GM」，不是「一个角色」——**T8 群聊与它同源**。

**变量系统（MVU / MagVarUpdate）—— 现代 RPG 类卡的重头戏**

卡让 AI 每轮末尾输出 `<update><json_patch>…</json_patch></update>`（RFC 6902 JSON Patch），
维护「世界时间 / 玩家属性与修炼进度 / 好感度 / 任务进度 / 背包 / 事件日程 / 场景角色状态」这套动态状态；
正则再把 `<update>` 从正文里洗掉、前端脚本渲染成状态栏。**T4 必须单独立项**（见下）。

**全局预设 = 一整台 prompt 模板引擎**

不是「几个采样参数」，而是：采样参数（temperature / top_p / top_k / min_p / max_tokens…）
+ **200+ 条可勾选的 prompt 注入**（`prompts[]`）。其中 `marker` 条目定义「角色描述 / 性格 / 情景 /
聊天示例 / 历史」的**拼接位置**——卡字段就是插进这些占位点；其余是条件注入：思维链 CoT、文风、
人称视角、内心独白、防打断 / 防复述、禁用词表、杀八股、破限、变量更新、前端功能等，
用 `{{setvar}}/{{getvar}}`、`{{//注释}}`、`{{trim}}` 宏与 `prompt_order` 装配。
→ T2 的 PromptBuilder 与 T4 的预设都按这个体量设计，不要按「几个字段拼接」写。

---

## 五、阶段拆分（MVP 优先，每阶段可运行、可验收）

> 编号 T0–T9 对应 insight 的阶段，但**去掉已完成与已砍项**。每阶段结束都要 `npm run typecheck` 干净、
> `npx vitest run` 不回退；UI 阶段 `npm run dev`（先 `unset ELECTRON_RUN_AS_NODE`）人工验证。

### T0 — 酒馆脚手架（SQLite + 窗口空壳）〔已完成 2026-10-25〕

> **实现说明（2026-10-25）**：`src/main/tavern/db.ts`（`DatabaseSync` + `schema_version` 迁移表，
> 一个迁移一个事务，WAL + 外键）、`src/main/tavern/migrations/000_init.sql`（14 张业务表）、
> `src/main/tavern/ipc.ts`（`tavern:open` / `tavern:close` / `tavern:ping`）、
> `src/renderer/src/tavern/shell.ts`（深海夜航 + 三栏，窄屏 ≤1080 收右栏、≤720 变单栏 + 底部切换）、
> 主进程 `tavernWindow`（1220×800，`minWidth: 480`）+ 托盘「打开酒馆…」，preload 暴露 `window.tavern`。
> **与原计划的偏差**：
> 1. 迁移文件放在 `src/main/tavern/migrations/`（不是根目录 `migrations/`），并用 `?raw` 内联进 bundle——
>    打包后不用从 asar 里读 `.sql`，也就没有路径问题；代价是一个 `src/main/env.d.ts` 声明。
> 2. `package.json` / `electron-builder.yml` **一行没改**：`node:sqlite` 是 Electron 自带的内置模块，
>    既不用加依赖，也不用管 `npmRebuild`。
> 3. `tavern:ping` 顺手当自检用，把「建了几张表 / 建库失败原因」直接显示在窗口顶栏，
>    建库失败只在启动日志里 `console.error`，不能连累桌宠本体。
> **验收**：`npm run dev` 托盘开窗 ✅；`tavern.db` 生成、15 张表（14 业务表 + `schema_version`）、
> 重启不重复迁移 ✅（`db.test.ts` 5 例）；`npm run typecheck` 干净、单测 299 → 304 全绿 ✅。
> **未验证**：`npm run dist` 打包版（T9 前会顺手验一次）。

**目标**：跑通「打开酒馆窗口 + SQLite 建库 + 迁移」的最小骨架。

**任务**
1. **数据层用 Electron 内置的 `node:sqlite`（`DatabaseSync`），不引入 better-sqlite3**——实测
   Electron 44.9.0 自带 Node 24.22.0，`require('node:sqlite')` 无需开关即可用，零 native 模块、零重建、
   不用动 `npmRebuild`（见「七、风险 1」）。同步 API，用法与 better-sqlite3 基本一致。
2. `src/main/tavern/db.ts`：`new DatabaseSync(userData/tavern.db)`，开 `journal_mode=WAL`、`foreign_keys=ON`；
   启动时按 `migrations/` 顺序执行未应用的迁移（用 `schema_version` 表记录）。
3. `migrations/000_init.sql`：建第四节的表。
4. 主进程 `src/main/index.ts` 新增 `tavernWindow`（沿用 `inputWindow` 模式：懒创建、单例、
   `loadFile(..., { hash: 'tavern' })`）；托盘加「打开酒馆」菜单项。
5. `renderer/src/main.ts` 路由加 `#tavern` → `renderTavernShell()`（空壳：左侧角色列 + 右侧占位）。
6. `preload/index.ts` + `index.d.ts` 暴露 `window.tavern` 雏形（`open()` / 一个空 `ping()`）。

**关键文件**：新增 `src/main/tavern/db.ts`、`migrations/000_init.sql`、`src/renderer/src/tavern/shell.ts`；
改 `src/main/index.ts`、`src/main/tray.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`、`src/renderer/src/main.ts`、`package.json`、`electron-builder.yml`。

**验收**：托盘点「打开酒馆」弹出空窗口；`tavern.db` 生成且表齐全（`sqlite3 userData/tavern.db .tables`）；
重启不重复建表；`npm run dist` 打包后仍能打开（验证 native 模块 OK）。

---

### T1 — 角色卡系统 + 角色库 〔已完成 2026-10-25〕

> **实现说明（2026-10-25）**：`src/main/tavern/cardFormat.ts`（ST v2 ↔ 内部结构，兼认 v1 平铺老卡）、
> `png.ts`（tEXt `chara` / `ccv3` 块的读写 + 纯色底板生成）、`cards.ts`（characters 表 CRUD、软删 / 恢复 / 清空、
> 立绘落盘 `userData/tavern/avatars/`、导入导出、用户人设存 `settings.user.persona`）、`ipc.ts`（`tavern:cards-*` 一组）、
> 渲染层 `tavern/{ui,library,cardEditor,profilePage}.ts`（主题与样式集中到 `ui.ts`，shell 改成「左栏列表 + 中栏路由」）。
> **与原计划的偏差**：
> 1. **缩略图不引 `sharp`**：立绘按原图存、渲染层 CSS 缩放（风险 2 里写的省事选项），主进程零 native 依赖。
> 2. **`.charx` 未做**（计划里本来就写「先做前两种」）。
> 3. **立绘不进 data URL**：注册自定义协议 `tavern-avatar://local/<文件名>`，主进程只放行 avatars/ 下的 uuid 文件名
>    （路径穿越已验证被拒）。一屏 24 张卡转 base64 会是几十 MB 的字符串。
> 4. **同名卡重复导入 = 覆盖更新**，不做「导入成新卡」的二选一，避免角色库里堆重名。
> 5. **分页是「加载更多」**（`limit`/`offset`），不做页码。
> 6. `pickGreeting()`（主开场白 + 备选随机）已实现并有单测；进聊天时取用的入口在 T2。
> **验收**：`npx vitest run` 304 → **329 例全绿**、`npm run typecheck` 干净（`cardFormat` 5 例 / `png` 5 例 / `cards` 15 例）。
> 打包版端到端实跑过（CDP 驱动）：建卡→网格与左栏刷新、标签筛选、回收站空态、人设存取、立绘协议正常加载 / 越权与缺失被拒。
> **未验证**：导入 / 导出的系统文件对话框需人工点选（主进程逻辑已被单测覆盖）。

> **补丁（2026-10-25 二次修正）：`data_json` 无损往返。** 用户拿两张真实成品卡验收后指出——
> 首版只搬运 12 个平铺字段，**导入时静默丢掉了世界书（`character_book`）、正则与脚本（`extensions`）、
> 群聊开场白（`group_only_greetings`）**，那才是这些卡的主体（见 §四·二）。
> 现已补：`characters.data_json`（迁移 `001_card_raw.sql`）整份存 ST 的 `data` 对象；
> `parseStCardFull` 交回「字段 + 原始 data」；`saveCard` 只把编辑页改过的 12 个字段合并进去，
> 其余原样保留；`exportCard` 用原始 data 回写。实测两张真卡：世界书 6 / 153 条、`extensions` 全部逐字一致，
> 单测 329 → **338 例全绿**。

> **补丁（2026-10-26）：版本标签也保真。** 扫了用户给的 99 张真实卡（96 PNG + 3 JPG）：
> **92 张有效卡里 62 张是 v3（`chara_card_v3`）、30 张 v2、0 张 v1**，另 7 个文件是纯图片（PNG 里没有
> `chara` 块，NovelAI 元数据之类）。原先导出固定写 `chara_card_v2` 等于把 2/3 的库存降级标注——
> 正文不丢（`data_json` 整份带出去），丢的是 v3 才有的能力（`assets` 立绘资源、`nickname` 之类）。
> 现新增迁移 `003_card_spec.sql`（`characters.spec` / `spec_version`）：导入时记标签、编辑页保存沿用、
> 导出原样写回；新建卡与 v1 卡仍写 v2。**升级前已导入的卡没有标签**，重新导入同一张（同名走更新路径）即补上。
> **v1 那条「导出缺 `extensions`」不修**：用户库里没有 v1 卡，ST 的 v1 导入路径也只认那 12 个平铺字段。
> 单测 552 → **555 例全绿**。

**目标**：SillyTavern v2 卡导入导出 + 创建/编辑 + 角色库网格。

**任务**
1. `src/main/tavern/cards.ts`：CRUD（写 `characters` 表）；ST v2 字段映射。卡图/头像存
   `userData/tavern/avatars/`，DB 里 `avatar_path` 存相对文件名（T9 备份整目录一起走）。
2. **导入**：`.json`（v2 字段）、`.png`（读 tEXt `chara` / `ccv3` 块 base64 JSON）、`.charx`（zip，先做前两种）。
   缺字段补默认；生成缩略图（`sharp` 已在 devDeps，但**主进程运行时**需要它——见风险 2；
   或缩略图用 CSS 尺寸缩放原图，避免引入 sharp 到运行时）。
3. **导出**：JSON + PNG（把卡 JSON 写进 tEXt）。
4. 创建/编辑页（纯 DOM）：头像上传/预览、名称、标签（全局标签表）、描述、主开场白、
   备选开场白（可增删排序）、对话示例、系统提示词、角色世界书/正则入口（T4 填）、用户人设
   （全局 profile，替代被砍的账号系统）。
5. 角色库页：搜索、标签筛选、网格卡片（封面 + 世界书/正则角标 + 名称）、分页。**不做「角色市场」tab**
   （市场一律砍掉，只留「我的角色」）。
6. FAB：导入角色 / 创建角色 / 创建群聊（T8）/ 清空（二次确认，软删 `deleted_at`）。**不做「获取角色」**（市场）。
7. 开场白：进聊天随机取一条（主/备选），可重 roll。

**验收**：导入任意 ST PNG 字段全对；导出的 PNG 能被 SillyTavern 识别；备选开场白随机正确；
清空有确认且软删可恢复。

---

### T2 — 聊天核心引擎〔已完成 2026-10-25〕

**目标**：单角色对话完整跑通：流式、小说流三色、消息树分支、重生成。

**任务**
1. **消息树**：`messages.parent_id` 从第一天建成；`branch_index` 标同父多分支。
2. **PromptBuilder**（`src/main/tavern/promptBuilder.ts`，纯函数、可单测）：
   ```
   [system] 预设 system_prompt + 预设 markers 装配（T4 接入全量，T2 先用一条直通模板）
   [system] 世界书激活条目：角色卡内嵌 character_book（T2 读卡；全局/会话层 T4 接入）
   [system] 角色描述（description 里的结构化人设）+ personality + scenario
   [system] 用户人设（本地 profile）
   [system] 文风指令（T4）
   [few-shot] mes_example
   [历史] 滑动窗口（按 parent 链回溯）+ 摘要（T3）+ 记忆注入（T3）
   [user] 用户输入
   [system] post_history_instructions
   ```
   - 装配顺序与「卡字段插在哪个占位点」由预设的 `marker` 条目决定（见 §四·二），T2 先用直通模板跑通，
     T4 再换成真正的 markers 机制——**但 T2 就要把「装配成一段 messages」这件事做成纯函数**，
     否则 T4 会返工。
   - 世界书激活规则（T2 最小版）：`constant` 常驻 + 最近 N 条关键词命中 `keys`，按 `insertion_order` 排，
     受 token 预算截断；有 `position` 区分插在角色定义之前还是之后。
   - 占位符 `{{char}}`/`{{user}}` 大小写不敏感。复用 `session.ts` 的 `estimateTokens`（修剪预算按角色卡
     体量另定，不用鲸鱼娘的 `HISTORY_MAX_TOKENS=4000`）；`withClock` 仅在需要提醒标记时注入，酒馆 v1 不注入。
3. **会话服务**（`src/main/tavern/chatService.ts`）：按 `chat_id` 从 DB 消息树组装请求体并驱动流式，
   **不用 `ChatSession` 类**（理由见 §3.4）。鲸鱼娘那条单例完全不动。
4. **流式**：复用 `deepseek.ts` 的 `streamChat`；新增 `tavern:send` / `tavern:token` / `tavern:done` /
   `tavern:error` / `tavern:stop`（**不要**复用 `chat:*`，避免与桌宠串流）。
5. **三色着色解析器**（`src/renderer/src/tavern/colorParser.ts`，纯函数、500 条单测）：
   旁白/对话（引号内）/动作（括号内）；未闭合按已开状态着色、闭合后修正不重排。
   **在 T2 就做**——它是「小说流阅读」的核心视觉，推迟会导致消息渲染层返工；三色**可定制**（取色器）放 T5。
6. **聊天页 UI**（纯 DOM）：顶栏（返回/头像/名字/在线点/永久记忆徽章/⋯）、小说流滚动、流式打字、
   输入栏（图片按钮占位）、⋯面板（快捷设置宫格 + 聊天操作宫格，入口按阶段可达）。
7. **消息操作**：重生成（同 parent 新 branch）、从此分支、编辑、软删、复制。

**验收**：任意卡聊 50 轮不串人设；重生成/分支互不污染；解析器跑 500 条真实消息零错乱；
11 个快捷入口全部可达（功能可后填）。

**落地记录（2026-10-25）**

- `chatStore.ts`：chats / messages 的消息树。当前分支的叶子记在 `chats.settings.activeLeafId`
  （没另建表，`settings` 本来就是会话级 JSON）；选中分支时沿 `parent_id` 回溯。重生成与编辑
  都是「同父再长一条分支」，旧内容留在树里可切回；软删只打 `is_deleted`，路径照常穿过去。
- `promptBuilder.ts`（纯函数）：直通模板 —— 卡的 `system_prompt` → `before_char` 世界书 →
  角色设定 / 示例 → 用户人设 → `after_char` 世界书 → 历史（按 token 预算裁最早）→ 本轮输入 →
  `post_history_instructions`。世界书读 `data.character_book.entries`，支持 `constant` / `keys` /
  `selective` + `secondary_keys` / `insertion_order` / `position`；
  `{{char}}`/`{{user}}` 大小写不敏感替换。T4 换成预设 markers 时只换这个函数的内部实现。
  **常驻条目全量注入、不受预算截断，也不占 `LORE_MAX_TOKENS`**（多角色卡的世界规则就是这个量级，
  算进用量的话关键词条目会被全挤掉），预算只挡关键词触发的条目。实测两张成品卡：单角色 6 条 / 激活 5 条 / system 7590 token；
  多角色 153 条 / 激活 23 条 / system 25797 token —— 后者每轮都贵，等 T4 的全局预算与预设调节。
- `chatService.ts`：按 `chat_id` 组装请求并驱动 `streamChat`（给它加了可选 temperature / maxTokens，
  鲸鱼娘那条不变）。通道 `tavern:chat-*`：open / new / view / send / stop / regenerate / edit /
  delete / branch，事件 `tavern:token|done|error`。**每个事件带渲染层给的轮次号**——连发两条时
  上一轮的 done 会晚于新一轮开始，不比对轮次号就会把新回复当成旧那轮收尾。
  **历史的终点与回复的挂载点是两件事**（`historyUpToId` / `parentId` 分开）：用户轮的历史取到
  新用户消息的父节点为止，否则刚存的这条会「历史里有 + `userText` 再追加一次」；重生成取到
  父节点，且不再追加空 user 消息（空 content 会被接口拒掉）。
- `colorParser.ts`（渲染层纯函数）：旁白 / 引号内对话 / 括号内动作；未闭合按已开状态着色。
- `chatPage.ts`：小说流 + 流式打字 + 分支「‹ 1/2 ›」+ 重生成 / 编辑 / 复制 / 软删 + ⋯ 面板
  （本场三项 + 11 个快捷设置 + 6 个聊天操作，未做的入口点了会说明排在哪个阶段）。
  进聊天入口：角色库点卡片、左栏点角色；编辑页仍从卡片右上角「编辑」进。
- **未含**（各自排在后面）：记忆注入与摘要（T3）、预设 markers / 深度注入 / 正则清洗（T4）、
  聊天搜索与导出（T5/T9）、图片输入（T6 前置）、聊天页顶栏的永久记忆徽章（T3）。

---

### T3 — 酒馆记忆三层（per-角色/会话）〔已完成 2026-10-25〕

**目标**：永久记忆 / 忆境典藏 / 回忆视界，全部在 SQLite、带 `character_id`/`chat_id` 维度。

**任务**
1. 永久记忆：每轮后异步抽取 → `memories` 表；发送前按当前输入检索（向量 + 关键词双路，
   **移植** `memory.ts` 的 bigram/余弦算法与 `embedding.ts` 客户端），注入 PromptBuilder。
2. 忆境典藏：每 N 条消息后台摘要 → `chat_summaries.dossier`（双用 schema）；聊天页「总结中」指示器；
   悬浮入口可看/改/删。
3. 回忆视界：视界深度 = 扩大最近消息条数；完整视界 = 不裁最近消息（提示增消耗）。
4. 记忆设置弹窗（三区块 + 滑块）。

**验收**：100+ 轮记得早期设定；三层独立开关生效；档案各字段非空；断网不阻塞聊天。

**落地记录（2026-10-25）**

- `memoryStore.ts`：永久记忆的 SQLite 版。**只复用纯逻辑、不碰鲸鱼娘的 JSON**——去重合并用
  `chat/memory.ts` 的 `mergeMemories`（同一套规则只写一处），检索用 `searchMemories` /
  `searchMemoriesByVector`，向量走 `chat/embedding.ts`。向量存 `memory_vectors`（float32 小端 BLOB +
  内容指纹 `h`），内容一改指纹就对不上、下次补齐自动重算，不写失效逻辑。写入按差异落库
  （新增 INSERT / 改动 UPDATE / 超上限淘汰 DELETE，一个事务）。
  **T3 只写 character 作用域**（`memories.scope = 'character'`），global / chat 两层留给 T4 的三层合并。
- 每轮抽取挂在「正常完成」这一支（打断 / 报错不抽）：只喂本轮的用户发言 + 回复，不重读整场；
  模型 `deepseek-flash`，失败静默。**检索查询 = 最近 `检索范围` 条消息 + 本轮输入**，让「接着刚才那个话题」
  也能召回；没有百炼 Key、超时、报错一律退回关键词，绝不挡住聊天（与鲸鱼娘那套一致）。
- `dossier.ts`（纯逻辑）：剧情档案 schema（insight 阶段 4 定死的那份）+ 摘要 prompt + 容错解析 +
  注入前的格式化（只拼有内容的字段）。`summaryStore.ts`：`chat_summaries` 的落库 / 列表 / 改 / 删；
  **每次摘要都带上旧档案**，模型把仍然有效的剧情节点并进去，早先的内容不会在第二次摘要后丢；
  首次摘要最多喂最近 120 条，别把几百轮一次塞进去。`to_message_id` 记锚点，之后只摘锚点之后的新消息；
  锚点被删 / 切了分支时按整场重摘一次。失败保留旧档案、下一轮再试。
- `promptBuilder.ts`：新增 `dossier` / `memoryContext` 两段，排在角色设定之后、历史之前；
  新增 `recentLimit`（视界深度，取最近 N 条）与 `fullVision`（预算设成 ∞）。
- `chatService.ts`：`startTurn` 变成「先 await 检索、再组装」。**登记 `active` 必须在 await 之前**，
  否则等向量的这几百毫秒里用户又发一条，`interrupt()` 收不住这一轮（两轮流式并发）。
  await 回来后若已被顶掉（aborted / 不是当前轮）直接 return，不重复发事件。
- `memorySettings.ts`：三层开关 + 滑块存 `settings` 表的 `memory` 键（全局一份），读的时候一律夹回合法区间
  （手改库 / 旧版本的值不能让逻辑跑飞）。
- 界面：聊天页顶栏加「忆境」入口（摘要进行中变成「总结中…」，`tavern:summary` 事件驱动）；
  ⋯ 面板的「记忆」不再是占位，打开 `memoryPanel.ts`——三区块（永久记忆 / 忆境典藏 / 回忆视界）+
  各滑块，下半截是「她记得的事」与历次档案，条目可直接改、可删。改设置立刻生效，不用点保存。
- **未含**：global / chat 两层的记忆作用域与三层合并权重（T4）、记忆条目的手动新增、历史档案的差异对比
  （只做了查看 / 改 / 删）、观测档案与鲸鱼娘观战的联动（T7）。

---

### T4 — 世界书 / 正则 / 状态栏 / 文风 / 预设 / 回复设置 〔3–4 天〕

**目标**：insight 阶段 5 全量，三层合并（全局 < 角色 < 会话）。**按 §四·二 的真实结构做，不是「几个字段」。**

**任务**
1. **世界书**：列表页 + 编辑器（导入导出 ST lorebook、一键常驻、扫描深度、Token 预算、条目 CRUD）；
   条目字段对齐真实卡：`keys`（主/次关键词）、`position`（before_char / after_char / @depth）、
   `constant`（常驻）、`selective`、`insertion_order`、`content`、大小写 / 整词等开关。
   **角色卡内嵌的 `character_book` 直接当角色层世界书加载**（只读视图 + 「另存为独立世界书」），
   T4 的编辑面不该要求用户重抄一遍。
2. **正则**：全局 / 角色两页；每条（名称 / 匹配 / 替换 / trim / 作用位置）；**测试与渲染**（实时对比）。
   导入卡时把 `extensions.piupiu_regex` / `regex_scripts` 识别为角色层正则（不自动执行用户脚本，
   只搬运与展示，并在 UI 里标明来源）。
3. **状态栏**：角色 / 用户两 tab；总开关、标题（支持 `{{char}}`/`{{user}}`）、显示项目；
   回复开头解析成顶部小条。
4. **文风**：内置 默认 / 中国古典小说 / 轻小说 + 导入 / 添加；注入 PromptBuilder。
5. **预设**：按真实预设的体量设计——采样参数（temperature / top_p / top_k / min_p / frequency /
   presence / max_tokens）+ **条目列表（数百条：markers + 可勾选注入）** + `prompt_order` + 宏变量
   （`{{setvar}}` / `{{getvar}}` / `{{trim}}`）。界面照 SillyTavern 的 Prompt Manager：分组折叠 + 勾选 +
   拖动排序；聊天页 pill 切换。**导入 ST 预设 JSON 直接可用**（首版至少保证 markers 与勾选状态不丢）。
6. **回复设置**：御言篇幅（最少/最多字数）+ 心动接话（生成 N 条可点选，异步、展示在输入栏上方）。
7. **变量系统（MVU）」单项（真实卡的 RPG 核心）**：解析回复末尾的 `<update><json_patch>…</json_patch></update>`
   （RFC 6902：`replace` / `add` / `remove`），落 `chats.settings` 里的状态对象；正则把该块从正文洗掉；
   提供状态栏渲染（后续可接卡自带的前端脚本，首版只做纯文本 / 简单列表）。**开关默认关**，
   打开后该卡才会被要求输出更新块。
8. **多角色卡 / 世界卡**：识别「`description` 很短 + `character_book` 条目极多」这类卡，聊天时按世界卡模式
   处理（卡自己就是 GM 指令，开场白用 `group_only_greetings`），与 T8 群聊共用一套判断。
9. **注入调试面板**（insight 称「PiuPiu酱没有的排障神器」）：发送前显示本轮注入了哪些
   世界书条目 / 记忆 / 状态栏 / 预设条目，以及各自占了多少 token。

**验收**：世界书能从零建一本并触发；导入两张真实成品卡后世界书与正则**自动出现在对应页且不改一字**；
正则测试页实时预览；切文风肉眼可辨；导入一份真实预设后 markers 与勾选状态正确；变量系统能跑通
「好感度 +3 / 时间推进 / 任务进度」；心动接话点选发送通；注入调试面板显示正确。

**落地记录（2026-10-25，已实现，待人工验收）**

1. **数据层**：新增迁移 `002_t4.sql`（`lorebooks` 补 `name` / `selective`、`regexes`、`presets`、
   `status_*` 等表列），**必须登记进 `db.ts` 的 `MIGRATIONS`**（`version: 3, name: 't4'`），
   否则迁移不跑、运行时直接报「no column named name」。
2. **世界书**（`worldbook.ts` 纯逻辑 + `lorebookStore.ts` 落库）：`readCardEntries` 把卡内
   `character_book.entries` 解析成统一条目；`activateLore` 常驻优先、关键词按 `scanDepth` 撞、
   预算只掐关键词条目；`mergeLayers` 全局 → 角色 → 卡内嵌 → 会话。界面一个面板五页签
   （`promptPanel.ts`）：列表 / 条目编辑（名、主次关键词、常驻、二级命中、位置、深度、序号、大小写）/
   ST 导入导出 / 卡内嵌只读列表 + 「另存为独立世界书」。
   **真实卡的坑**：`multi_role` 153 条全带 `extensions.depth`，但顶层 `position` 只有
   `before_char` / `after_char`——**depth 本身不等于「按深度注入」**。「@深度」写在
   `extensions.position === 4`（`1` = 角色定义之后），ST 的 `convertCharacterBook` 也是这么读的；
   实测多角色卡有 61 条深度条目，只读顶层会把这批全塞进角色设定块。导出时顶层写前 / 后、
   深度另写 `extensions.position = 4`，否则导出再导入同样丢深度。
3. **正则**（`regexEngine.ts` / `regexStore.ts`）：全局 / 角色两页 + 实时测试 + 整段预览；
   `markdownOnly → display`、`promptOnly → prompt`、都不是 → both；显示正则在出库
   （`getChatView`）套用，提示词正则在组装请求前套用。卡内 `extensions.regex_scripts` /
   `piupiu_regex.scripts` 只搬运展示、**不执行卡里的脚本**。
4. **预设**（`preset.ts` 纯逻辑 / `presetStore.ts`）：ST 预设 JSON 直接导入（采样参数 + 数百条
   prompts + `prompt_order`，markers 与勾选状态不丢）；`toStPreset` 整份回写导出；
   界面是 Prompt Manager：采样参数、按 `prompt_order` 的逐条勾选与上下移动、全局激活 + 会话绑定。
   **深度注入层号**：ST 的 `depth` 把本轮用户输入算第 0 层，我们的 `history` 不含它，所以索引是
   `length + 1 - depth`（写成 `length - depth` 会整体早一条）；预设里 `injection_position=1`
   的条目必须**在 `chatHistory` 推出去之前**先插进历史，事后 splice 永远进不了 messages。
5. **文风**（`promptSettings.ts`）：内置中国古典小说 / 轻小说 / 文艺细腻 + 自定义增删，选中项注入
   PromptBuilder；另有「不加文风」。
6. **回复设置**：御言篇幅（最少/最多字数，0 = 不限）+ 心动接话（每轮 N 条，1–5，0 = 关）。
   接话经 `tavern:alternatives` 事件下发，聊天页显示在输入框上方，**点一下填进输入框、不自动发送**。
7. **变量系统（MVU）**（`mvu.ts` / `variableStore.ts`）：解析 `<update><json_patch>…</json_patch></update>`、
   `<UpdateVariable>`、`<status_description>`，RFC 6902 add / replace / remove（自动建中间层、数组
   `-` 追加、`~0`/`~1` 转义）；状态存 `chats.settings.variables`；流式时 `holdPartialTag` 扣住末尾半个标签。
   **开关默认关**；不管开关，这些标签永远从正文洗掉。
8. **状态栏**：聊天页顶栏状态条（`chat-status`），开关 / 「状态写进提示词」/ MVU 三开关在
   「状态栏」页签；面板里还能看这场对话的当前变量并清空。
9. **世界卡识别**：`getChatView` 带 `worldCard` 标记，聊天页标题旁显示「世界卡」徽章。
10. **注入调试**（`chatService.ts` 的 `tavern:debug-get`）：聊天操作「注入调试」列出这一轮的分段
    （label / 来源 / token）、命中的世界书条目、被预算挤掉的条目、历史条数与合计 token。
11. **界面**：新增 `src/renderer/src/tavern/promptPanel.ts`（五页签 + 调试面板），`chatPage.ts`
    把原先 7 个 `later(...)` 占位（回复 / 状态栏 / 全局世界书 / 全局正则 / 全局预设 / 角色世界书 /
    角色正则）与「注入调试」换成真实入口；`ui.ts` 的 `TAVERN_CSS` 补面板与状态条样式。

**未含**：预设条目的内容编辑（只能勾选 / 排序，改正文要导出改再导入）；世界书条目拖拽排序
（用序号输入代替）；正则 `trimStrings` / `runOnEdit` / `placement` 等 ST 高级项；世界书的
`selectiveLogic` / `use_regex` / `match_whole_words` / `probability` / `sticky` 等高级匹配项
（现有两张真卡都没用到：触发词全是纯文本、`selectiveLogic` 未设置；真要用得给 `LoreEntry`
加字段 + 追加迁移，等有样本再做）；状态栏的角色 / 用户双 tab 与项目级显示开关（现为整条纯文本）；
变量随分支回滚（状态是会话级的，切分支不回退变量）；卡自带前端脚本渲染。

**复审修复（2026-10-25）**：
- 世界书「@深度」按 `extensions.position` 读、导出时写回（原来只认顶层 position，61 条深度条目
  会被当成角色设定块；导出再导入也会丢深度）。
- 正则规则没有 `g` 时补上（与 ST 一致；原来 `String.replace` 只换第一处，预览报「命中 3 处」却只替换 1 处）。
- 重生成会清掉上一版「心动接话」并重新生成（原来不清缓存，输入栏上停着对不上的句子）。
- 状态栏超过 3 层嵌套的对象压成 JSON 显示（原来显示 `[object Object]`）。
- 预设条目里的 `{{char}}` / `{{user}}` 现在也会替换（真实预设 236 条里有 59 条带占位符，
  原来字面量直接发给模型）；卡的 `system_prompt` 按 ST 语义**取代** Main Prompt（原来启用预设后
  卡的系统提示整个不被注入）；`role` 为 user / assistant 的条目单独成条（原来被拍进 system）；
  `postHistoryInstructions` 改到本轮输入之后（原来在输入之前，与直通模板不一致）；
  没有 `worldInfoBefore/After` marker 的预设会把世界书兜底注入（原来整本书静默消失）；
  调试面板不再重复统计世界书 token、不再谎报未注入的条目。
- 世界书预算：被挤掉的关键词条目不再把同内容的常驻副本一起挡掉。
- MVU：数组 `replace` 越界不再撑长数组（状态栏会出现 `1、2、、、x`）；数组解析失败时
  逐条兜底能正确抠出 value 为嵌套对象的 op。
- 预设 `openai_max_tokens: 0`（ST 里表示用后端默认）不再原样发给接口（会 400）；
  `savePreset` 遇到预设已被删除时按原 id 补回，不再「提示已保存但改动全丢」。
- 世界书 / 正则编辑器里的开关（常驻、二级命中、区分大小写、规则启用）改成点一下即落库。

单测 **401 → 492 例**（`worldbook` 17 / `preset` 12 / `regexEngine` 13 / `mvu` 20 / `t4Store` 15 /
`promptBuilder` +13 / `db` 迁移列表），`npm run typecheck` 与 `npm run build` 均通过。

#### T4 验收反馈修复（2026-10-25）

三条都是「按 ST 的用法做了半截」暴露出来的：

1. **卡内嵌世界书 / 正则改为可原地编辑**（原来只读 + 另存为）。新增 `cardEdit.ts`（纯逻辑）：
   `upsertCardLore` / `removeCardLore` / `upsertCardRegex` / `removeCardRegex`，只覆盖界面管的字段，
   卡里的其它键原样往回写；`cards.updateCardData(id, mutate)` 负责落 `data_json`，
   `tavern:card-lore-entry-save|-delete` / `tavern:card-regex-save|-delete` 四个通道接界面。
   **不做「另存为后两份都注入」**——编辑就是改卡本身，导出卡时一并带走。
   编辑面读条目用 `readCardEntries(data, { includeEmpty: true })`，否则新建的空条目刷不出来。
2. **进卡先选开场白**（原来 `alternate_greetings` 只是被随机抽中）。`chatStore.greetingOptions()` 出
   可选项，`createChat(characterId, random, greetingIndex)` 支持「指定 / 不用 / 随机」三态；
   通道 `tavern:chat-greetings` / `tavern:chat-start`，界面 `greetingPicker.ts`（正文预览、取消回角色库）。
   「重开一场」也走同一个选择框。
3. **状态栏 ```html 渲染成 sandbox iframe**（原来几千行代码直接摊在聊天里）。`richText.ts` 把正文
   切成 text / html / code 三段，html 段进 `sandbox="allow-scripts allow-forms allow-popups"` 的 iframe，
   页面内的 `frameReporter` 用 `postMessage` 报高度、父页自动调高；流式显示时围栏整段藏起来。
   显示路径同时替换 `{{user}}` / `{{char}}`。

另外：全部窗口 `spellcheck: false`（消掉 Chromium 词典请求引发的 `net_error -100` 噪声）。
单测 **492 → 512 例**（`cardEdit` 8 / `richText` 8 / `chatStore` 开场白 3 / `regexEngine` +1）。

**第二轮修复：状态栏「显示不全 / 聊一轮就没了 / 按钮没反应」（2026-10-25）**
1. **状态页缺酒馆运行时**。卡自带的整页 HTML 直接调 `$` / `_` / `getAllVariables().stat_data` /
   `waitGlobalInitialized('Mvu')` / `errorCatched`——放进沙箱 iframe 后这些全局全不存在，脚本第一句就抛错，
   页面停在模板里的 `N/A` 上。新增 `statusBridge.ts` 注入一套等价实现（mini jQuery + lodash 子集 + 变量接口），
   注入脚本拼在卡页面之前。
2. **变量初值来自 `[initvar]` 条目**（卡里它是 `enabled: false`，`readCardEntries` 读不到，
   要直接翻 `data.character_book.entries`）。新增 `mvuInit.ts` 解析该条目的 YAML 子集；
   `variableStore.loadOrInitVariables` 在会话首次读变量时落库。
3. **每轮都该有的面板要补**。单角色卡的 `<StatusPlaceHolderImpl/>` 本由 MVU 前端扩展给每条 AI 消息补、
   多角色卡的状态块靠模型自己输出，我们两头都没有 → 面板只在开场白出现一次。新增 `statusPanel.ts` 的
   `carryPanels`：只给**最后一条**回复补，且只补**开场白里就出现过**的面板（论坛 / 罗托姆手机是按需弹出的）。
   补的是原块（`[宝可梦状态栏_始]…`），数据照常再走一遍显示侧正则。
4. **面板里的按钮**。状态页用 `parent.postMessage({type:'send_message', message})` 把话递回酒馆，
   父页用 `event.source` 核对是自己的 iframe 后填进输入框（不自动发送）。
5. `mvuEnabled` **默认改为开**（成品卡的状态栏就是照变量画的）。
6. **顶部纯文本状态条和卡的状态页重复**（验收第三眼的「显示依旧不对」）。聊天页顶上的 `.chat-status`
   是 T4 给「只有变量、没有页面」的卡做的兜底，`formatStatus` 把变量压成 `世界/当前时间: …` 铺满整屏，
   把真正的状态页挤到看不见。现在 `tavern:status-get` 返回 `ownPanel`（`statusPanel.hasStatusPage`：
   显示侧规则的替换串里有 html 围栏就算卡自带状态页），渲染层据此不画那条；`.chat-status` 另加 66px
   高度上限，别的卡变量再多也只占一条。

单测 **512 → 529 例**（`mvuInit` 4 / `statusPanel` 7 / `statusBridge` 5 / `t4Store` 默认值改口径）。**复审三修（2026-10-25，`/code-review`）→ 531 例**：空 pattern 规则不再参与替换（`/(?:)/g` 逐字打碎正文）、`presetHasMarker` 按启用口径判（marker 被取消勾选时世界书整轮消失）、心动接话加代次号（迟到的生成结果丢弃）；**第二批 → 533 例**：预设 marker 提供 `main` 时卡的系统提示不再重复注入、卡内嵌正则 id 与列表侧同口径（拼接后连续编号）、「清空状态」加 `variablesInit` 记号（空即空，不再被 `[initvar]` 填回）；**第三批 → 535 例**：预设无 main 条目时默认角色指令不再漏发、流式增量改为「已发原文 + 前缀比较」（洗标签让 clean 变短时不再吞字）、调试面板世界书记账条件与装配分支统一。
另用一个隐藏 Electron 窗口把拼好的「卡状态页 + 注入运行时 + `[initvar]` 变量」真跑了一遍：
`#current-time` / `#current-location` / 场景角色 / 任务 / 玩家修为全部取到真值，`error-tip` 为空。

**第四轮全面复检（2026-10-25）→ 552 例**

前四批都盯着「刚改过的代码」，这一轮换了角度：四个方向并行深查（提示词装配 / 运行时链 /
存储编辑面 / 渲染层），并用两张真实成品卡（苏月珑 / 宝可梦）+ 真实预设（236 条 / 232 条 order）
做端到端装配取证。查实并修掉 13 条：

1. **卡内正则编辑面漏传 `forEditing`**：`tavern:regex-all` 的 `card` 分支用默认（过滤空 / 禁用），
   表现是「加一条」点了没反应、关掉的规则永远打不开。
2. **新建卡内条目会撞下标号**：`entryKey` 的口径是 `id ?? uid ?? 下标`，新建时只数数字 id。
3. **裸 pattern 改 flags 不落库**：`formatFind` 只在原文是 `/…/flags` 时拼 flags。
4. **`saveVariables` 不写 `variablesInit`**：模型把顶层键逐个删空后，下次读取当成「还没初始化」，
   `[initvar]` 把整份初始值填回来。
5. **MVU 标签变形**：`<UPDATE>` / `<update >` / `</update >` / `<json_patch version="1">`；
   以及**没套 `<update>` 壳的裸 `<json_patch>`**——正文照样被洗掉、ops 却抠不到，变量永远不更新。
6. **`parsePatch` 的 `indexOf('[')`** 会从 value 的数组括号截起，`["药"]` 恰好合法 → 整批 ops 丢弃。
7. **RFC 6902 的 `test` op 被整条丢掉**：守卫语义丢失，后面的 remove / replace 照跑。
8. **预设 `main` 条的正文被默认句顶掉**（卡没写 `system_prompt` 时，ST 用的是预设 main 的正文）。
9. **深度条目的 `{{getvar}}` 取空**：`chatHistory` 排在深度条目之前的真实预设下，单遍扫描推进不了 vars → 改两遍扫描。
10. **`{{format_message_variable::stat_data}}` / `{{lastusermessage}}` 未实现**，且变量只在
    `statusInPrompt` 开着时才取——卡的状态栏宏在默认配置下永远是空串。现在变量只要 MVU 开着就取，
    `statusInPrompt` 只管「额外再补一段摘要」。
11. **老格式世界书的数字 `position`**：`1` / `3` 落在末尾的 `before_char`，后置设定跑到角色设定前面。
12. **切回内部节点时找不到最深叶子**（`resolveLeaf` 直接把它当叶子）→ 后面几轮从界面消失、下一条另开分支。
13. **`/…/flags` 写进全局 / 角色规则的 pattern 字段**时斜杠进正则本体、永远 0 命中；外加 mini jQuery 补
    `data` 的 jQuery 真假值解析、`css` 的连字符属性、`ready`、三参数 `on`（委托写法把字符串当 handler 会抛 TypeError）。

单测 **535 → 552 例**（`mvu` +6 / `promptBuilder` +6 / `regexEngine` +1 / `cardEdit` +2 / `chatStore` +1 /
`worldbook` +1 / `t4Store` +1），`npm run typecheck` 与 `npm run build` 均通过。
真实卡端到端复核：预设 main 正文保留、文风段取到真实内容、深度注入按预期插在历史之后，
苏月珑卡的未替换宏从 2 种降到 0 种。

---

### T5 — 聊天外观 + 通用设置 〔1–2 天〕

**任务**
1. 背景（默认 / 跟随角色封面 / 自定义图片）；气泡（样式/透明度/字号/高亮色/括号色/普通色，
   与三色解析器共用 CSS 变量，改色即时生效）。
- **语音朗读开关**（酒馆回复是否朗读，**默认关**，用户自选；复用现有 TTS；每角色音色映射后置）。
2. 通用：黑夜模式（全 app，含现有小窗）、可爱字体（内置两套）、背景音乐（开关/音量/曲目）。
3. 即改即存（`settings` 表），保存按钮语义为「重置为本页修改前」。

**验收**：三色取色与小说流共用变量、改色全局生效；黑夜模式无漏网白底。

**落地（2026-10-31，待人工验收）**
- 字体不做内置字体包（用户拍板）：`FONT_STACKS` 两套系统栈（默认 / 圆体 `YouYuan·幼圆` 回退微软雅黑），零体积。
- 背景音乐不做内置曲目（用户拍板）：设置页选本地音频，`saveMedia` 用 uuid 拷进 `userData/tavern/media/`，
  靠 `tavern-media://` 协议读取（与 `tavern-avatar://` 同款白名单 + 路径穿越校验），单个 `Audio` 循环播放。
- 主题两套（深海夜航 / 浅海晨光）：`applyAppearance` 把 `data-theme` + `--seg-*` / `--bubble-alpha` /
  `--chat-font-size` / `--font-stack` 挂在 `html` 上；`ui.ts` 末尾一段 `html[data-theme="light"]` 覆盖，
  深色规则一行未改。三色默认值只给深底调过，切浅色时若用户没改过颜色会自动换深字色。
- 小窗跟随：新增 `petTheme.ts`，把配置 / 记忆 / 提醒 / 输入栏四个窗的硬编码颜色全换成 `--pet-*` 变量
  （默认值就是原来的深色），`initPetTheme()` 拉一次设置并订阅 `tavern:onAppearance` 广播。
- 朗读（默认关）：`chatService` 复用 `SpeechStreamer` + `synthesizeSpeech`（音色 / 千问 Key 读 `loadConfig`），
  每句合成好下发 `tavern:tts`，收尾 `tavern:tts-end`，新发言 / 打断 / 出错发 `tavern:tts-stop`；
  渲染层用 `VoicePlayer` 排队念，离开聊天页整队停下。
- 数据层 `appearance.ts` 存 `settings` 表 `appearance` 键，读写的两端都过 `sanitizeAppearance`（数值夹取、
  颜色只认 `#rgb` / `#rrggbb`、媒体文件名白名单）；新单测 9 例，总计 **597 例**。

---

### T6 — 配图（文生图）〔可选，1–2 天，需付费图 API〕

**目标**：回复配图。**本期不做**（用户拍板暂缓）：做成用户可选开关，但要用户自配生图 Key，且与「全免费差异化」相抵，等有需求再启动。

**任务**：`ImageProvider` 抽象 + 接一家（用户配 Key）；自动配图（LLM 出 prompt → 异步生图）
/ 手动配图（输入栏按钮）；开关/尺寸/风格后缀；生成走队列、失败占位。

**验收**：两种模式各跑通；关开关零调用；生图期间聊天不间断。

---

### T7 — 鲸鱼娘旁观者模式 ★ 差异化核心 〔3 天〕

**目标**：她观战酒馆会话：观测档案、浮窗问答、灵感、角色卡编辑器助手。**问才答，不问不扰。**

**任务**
1. 会话设置「让鲸鱼娘观战」（默认关，按 `chat_id` 记忆）；开启后该会话的 T3 摘要同时刷新观测档案。
2. `src/main/tavern/spectator.ts`：从 `tavern.db` 读「会话摘要 + 角色卡摘要 + 记忆」（**只读**），
   拼成一段观战上下文。
3. **浮窗问答**：用**一次性 messages**（`system = 鲸鱼娘 persona + 观战上下文`，直接调
   `deepseek.streamChat`）或**独立的 `ChatSession` 实例**来回答，**绝不把观战上下文塞进主单例的
   `session.setSystemContext()`**——那是持久字段，会污染她和用户的日常聊天（初版这里写错，已改）。
   回答穿鲸鱼娘口吻（不入戏、不替角色做决定、档案没有的说「看不清」、慵懒温柔带海洋比喻）。
4. **灵感模式**：`/idea` → 基于档案 + 激活世界书给 2~3 个剧情方向，引用真实节点。
5. **编辑器助手**：「问问鲸鱼娘」审卡/帮写/建议。
6. **观战可视化**：观战开启时她待机切「注视」动作——**需新动作素材，用户拍板暂不做**；本期只做上下文与问答，
   素材到位后再接（`petCore` 加一个动作参数即可）。
7. 所有输出走鲸鱼娘口吻，禁「作为 AI 助手」。

**验收**：观战 50 轮后能答对剧情进度/人物态度；灵感引用真实节点；审卡指出矛盾；关观战后档案隔离。
**关键约束**：鲸鱼娘读酒馆数据全程在主进程、只读、不写 `tavern.db`；不改她自己的 JSON 记忆。

**状态：已完成（2026-10-31，待人工验收）**

- **观战开关**：`chats.settings.spectate`（沿用 `activeLeafId` 的做法，不加表 / 迁移），`chatStore.spectateEnabled` / `setSpectate`；默认关，按会话记。打开时顺手 `summarizeNow` 刷一次观测档案，不用等几十轮才看得见。
- **只读上下文**（`src/main/tavern/spectator.ts`）：`getChat` / `getCard` / `latestSummary` / `activePath`（最近 12 条，每条过 `extractUpdates` 剥掉变量块、截 700 字）/ `listMemories`（12 条）/ `formatStatus(loadVariables())`。`buildObserveContext` 与 `formatObserveContext` 分开，纯函数好测；没有档案时明写「还没有」，不让她硬编。
- **一次性 messages**：`[system: SYSTEM_PROMPT + 本轮规则 + 观测材料, user: 问题]`，走 `streamChat`（流式展示，不是静默 `completeChat`）。**没有碰 `session.setSystemContext()`**——那是鲸鱼娘主会话的持久字段，塞进去会污染日常聊天。模型读全局 `config.model`（会话为了状态栏切 pro 也不跟）。
- **两套规则**：`ASK_RULES`（旁观口吻、只依据材料、看不清就说、2~4 句、不要标签/分点）与 `IDEA_RULES`（2~3 个方向、必须引用真实节点、每行「·」）；`spectatorSystem(context, mode)` 切换。
- **流式清洗**：`makeStreamCleaner` 复用 `stripStrayTags`（情绪标记，含半截）+ `stripReminderTags`（提醒标记），按前缀比较发增量（与酒馆正文同一条规矩）；收尾 `finish` 放行被扣住的尾巴。
- **IPC**（`spectatorIpc.ts`）：`tavern:spectator-get` / `-set` / `-ask`，`tavern:card-assistant-ask`；每个 key 一个代次号 + `AbortController`，新问题顶掉旧问题，被顶掉那次不报错。事件带 `chatId`（观战）/ `characterId`（审卡），渲染层按 id 认领。
- **界面**：右栏观战抽屉 `spectatorPanel.ts`（状态点 + 开关、「刚才发生了什么？」「出点主意」两个 chip、日志只存内存 40 条不落库、输入框）；角色卡编辑页工具栏「问问鲸鱼娘」（`cardAssistant.ts`，遮罩面板，审卡 / 帮写两个快捷问法）。两处都复用 `.spec-*` 样式与深浅两套主题。
- **单测**：`spectator.test.ts` 9 例（上下文拼装、档案缺失提示、会话隔离、标记清洗、只读不写库、空问题拒绝、idea 规则、审卡材料含世界书条目名）。全量 598 → **607 例**全绿、`npm run typecheck` 干净、`npm run build` 通过。
- **未含**：观战可视化「注视」待机动作（等素材，用户拍板暂缓）。

---

### T8 — 群聊基础版 〔2 天〕✅ 已完成（2026-10-31，已通过人工验收）

**目标**：选 2~5 个角色建群；桌宠**不入群**。

**任务**：`chats.is_group`；消息 `角色名: 内容`；发言调度（被 @ 必回，cheap 模型相关性打分过阈值才回，
每轮最多 2 人）；群聊 UI。

**验收**：3 人群聊自然不刷屏；@ 必回；无刷屏。

- **数据层（不加迁移）**：成员记在 `chats.settings.members`（与 `activeLeafId` / `spectate` 同一套做法），
  `chats.is_group` 本来就有；`character_id` 借用第一个成员（NOT NULL + 外键）。新增
  `createGroupChat` / `groupMembers` / `groupMemberIds` / `listGroupChats`（`chatStore.ts`）。
  **`latestChat` 加了 `AND is_group = 0`**——否则「点第一个成员进单聊」会被这场群聊顶掉。
- **发言调度**（`src/shared/groupChat.ts` 纯逻辑 + `chatService.ts` 调度）：文本里 `@名字` 的人必回
  （按出现顺序、最多 2 个；长名字优先匹配，`@阿蕾蕾` 不会被当成 `@阿蕾`）；没人被 @ 时用
  `deepseek-flash` + JSON 模式打相关性分（`{"scores":{名字:0..1}}`，温度 0，预算 2000，10s 超时），
  过 0.5 的按分降序取最多 2 人；打分失败 / 全没过就按轮数轮流，保证总有人接话。
- **一个发言人一次请求**：把「这轮轮到你，只扮演 X」写进 system，依次生成，前一个人说的话进后一个人
  看到的历史；消息落库是 `名字：内容`，渲染层用同一份 `parseSpeaker` 拆成「小立绘 + 名字」抬头。
  流式时 `stripSpeakerPrefix` 会把还没收全的名字前缀扣住（模型偶尔无视规则先写「阿蕾：」）。
- **界面**：角色库工具栏「群聊」→ `groupPicker.ts` 多选 2~5 个（可选群名）；左栏顶部「群聊 · N」列表
  按最近聊过排序；聊天页群聊形态 = 群名 + `群聊 · N 人`、发言人抬头、输入框提示 `@某个人`；
  忆境 / 状态栏 / 世界书 / 正则 / 预设 / 重开一场 / 编辑角色在群聊里整块隐藏（模型 / 回复上限 / 我的人设
  照常）；右栏旁观抽屉显示「群聊里人太多，她看不明白谁在说话」并锁上输入。
- **未含**：群聊记忆抽取 / 归档摘要、群聊朗读、群聊世界书按人分流（现在是成员世界书合并后按关键词激活）、
  建群后增删成员、群聊显示侧正则（几条规则混套会把别人的台词一起洗掉，故意关掉）。
- **复审修复（2026-10-31，`/code-review`）**：① 打分预算 800 → 2000、超时 8s → 10s（推理 token 和正文
  共用预算，800 会被思考吃光、返回空串让它永远走轮换，且解析失败现在会 `console.warn` 出原文）；
  ② 建群人数上下限 `GROUP_MIN_MEMBERS` / `GROUP_MAX_MEMBERS` 从 `chatStore` 挪到 `src/shared/groupChat.ts`，
  建群弹窗与主进程校验用同一份；③ `listGroupChats` 排序补 `rowid DESC`（`updated_at` 只到秒，同一秒建的
  两个群先后不定，测试偶发红）；④ 群聊打断改为**同步落半句**（`GroupRound.settlePartial`）：原先半句要等
  abort 的 rejection 才 `appendMessage`，而新用户消息已经先挂到旧叶子上，`appendMessage` 又把叶子顶回旧分支
  ——新一轮若一个字都没出，刚发的那条会从界面消失；⑤ `buildGroupSystem` 补 `{{char}}` / `{{user}}` 替换
  （成员按自己的名字、玩家与世界书按本轮发言人），不再把字面量发给模型。
- **单测**：`groupChat.test.ts` 17 例 + `chatStore.test.ts` 群聊 5 例，全量 607 → **631 例**全绿、
  `npm run typecheck` 干净、`npm run build` 通过。
- **已用 CDP 驱动真实应用端到端验过**：@苏月珑 → 只有她回；不带 @ 的「有勇者来了」→ 打分挑了 2 人、
  每人一条；3 人组「你们都在忙什么」→ 正好 2 人接话（不刷屏）；重生成某一条 → 同一发言人长出新分支
  （‹2 / 2›）。测试建的群聊已从用户库里删掉。
- **人工验收（2026-10-31）**：用户真实数据上逐项走了一遍——@点名单人必回；不带 @ 打分挑 2 人各一条；
  停止后立刻再发（半句同步落库、新消息不消失、`location.reload()` 后顺序正确）；重生成同一发言人长分支；
  建群弹窗 2~5 人上下限与端到端建群（`--user-data-dir` 临时档案隔离，真实库未被动）；群聊形态隐藏状态栏 /
  世界书 / 预设 / 忆境；旁观抽屉的群聊提示；左栏群聊分组置顶。全部通过。
- **验收补的一处观感**：被打断留下的半句现在挂一个灰色「被打断了」小标记——原先读起来像莫名其妙断在一半。
  实现与 `activeLeafId` / `members` 同一套做法：记在 `chats.settings.interruptedIds`（不加表不加迁移），
  `chatStore.markInterrupted(chatId, messageId)` 写入，`activePath` 返回 `interrupted: boolean`，
  `chatPage` 画 `.msg-cut`。单聊 `interrupt()` 与群聊 `settlePartial` 两处落半句时都记一笔。
  单测 633 → **634 例**全绿。

---

### T9 — 打磨与发布 〔2–3 天〕

> **代码三项已完成（2026-10-31），待人工验收；第 4 项打包终检留到最后单独跑。**

**任务**
1. ✅ **备份与恢复**：`userData` 全量打包成 **单个 `.zip`**（新增纯 JS 依赖 `adm-zip`）导出/导入。
   `src/main/tavern/db.ts` 新增 `checkpointTavernDb()`（`PRAGMA wal_checkpoint(TRUNCATE)`），
   `backup.ts` 导出前先 checkpoint；清单 = 顶层 `*.json` + `tavern.db` +
   `tavern/avatars/`、`tavern/media/` 两个资产目录（**不带 `-wal` / `-shm`**：那是 SQLite 跟进程绑死的
   运行时文件，搬走或跟另一份库拼在一起会被当成损坏日志）。导入先校验压缩包里有 `tavern.db`（否则拒绝）、
   关库后删掉旧的 `-wal` / `-shm`、再只写清单内的路径（带路径穿越防护），成功后重启。
   入口：酒馆顶栏「⚙」→「设置与帮助」。
   **重启的两种走法（2026-10-31 修复「导入后自动重启卡死」）**：打包版 `app.relaunch()` + `app.quit()`
   （用 quit 不用 exit，好让 `will-quit` 停全局鼠标钩子、释放光标裁剪）；**开发模式下不能 relaunch**
   ——Electron 一退，electron-vite 连同进程里的 vite dev server 一起退出，新开的壳子加载的是已经不存在的
   `localhost:5173`，表现就是**白屏卡死**。开发模式改为弹框说明后 `app.quit()`，由用户自己重跑 `npm run dev`。
2. ✅ 首次启动引导：空库且没走过引导时弹遮罩（导入第一张卡 / 跳过），记号存全局 `settings` 表
   `tavern.onboarding`（`onboarding.ts`，不加表不加迁移）；第一轮回复完成后一次性小提示。
3. ✅ 关于/帮助/版本（托盘「关于鲸鱼娘…」+ 设置面板内版本号，`app.getVersion()`）；
   **崩溃恢复**：消息树里「分支末尾是 user、底下没有回复」的悬空消息由 `activePath` 标
   `resendable`（零迁移），界面给「重发」按钮 → `tavern:chat-resend` → `chatService.resend()`
   （单聊历史取到该消息、群聊把这句话当本轮 userText，都不重复落库用户消息）。
4. ⏳ 打包终检：24h 内存（沿用「总和 ≤ 500MB 且渲染 ≤ 200MB」口径）、500+ 消息滚动、全功能走查。

**验收**：安装包可跑、备份能还原、长会话流畅、内存达标。

---

## 六、明确「不重做」清单（已验收，别动）

| 能力 | 落点 |
|---|---|
| 桌宠动画/状态机/互动/投喂 | `renderer/src/{animator,petCore,stateMachine,gestureDetector,riceBowl}.ts` |
| 鲸鱼娘单角色聊天（流式/打断/情绪/朗读） | `main/chat/{ipc,session,persona,deepseek}.ts` |
| 鲸鱼娘记忆（手账/语义检索） | `main/chat/{memory*,embedding}.ts`、`renderer/src/memoryPage.ts` |
| TTS 双通道（Edge/千问）+ 流式朗读 | `main/chat/{tts,speech,speechStreamer,qwenTts,edgeToken,localTts}.ts` |
| ASR 语音输入 | `main/chat/asr.ts`、`renderer/src/voiceRecorder.ts` |
| 提醒（含增强） | `main/chat/reminder*.ts`、`renderer/src/reminderPage.ts` |
| 主动消息 / 好感度 | `main/chat/proactive.ts`、`main/proactive.ts`、`renderer/src/affection.ts` |
| 托盘 / 自启 / 多屏 / 配置窗 | `main/{tray,autostart,windowPlacement,windowState}.ts`、`renderer/src/chatConfig.ts` |
| 打包发布 | `electron-builder.yml` |

**本次不改任何老代码**：`session.ts` / `persona.ts` / `ipc.ts` 保持原样（初版曾计划参数化 `ChatSession`，
现判定酒馆不复用它，见 §3.4）。新增代码全部落在 `src/main/tavern/` 与 `src/renderer/src/tavern/`。

### 六·二、明确**不做 / 暂缓**（2026-10-25 用户拍板）

| 项 | 决定 | 说明 |
|---|---|---|
| 账号 / 邀请 / 用户 ID | **砍** | 需服务端，且与「全免费差异化」矛盾；用户人设降级为本地 profile |
| 角色市场 / 世界书市场 / 正则市场 / 预设市场 / 获取角色 | **不做** | 全部依赖服务端；角色库只留「我的角色」，市场入口不出现 |
| 酒馆角色独立好感度 | **不做** | 好感度只属于鲸鱼娘（现有 `affection.ts`），酒馆角色不设数值 |
| 配图（文生图） | **暂缓** | 用户可选开关，但要自配生图 Key；等有需求再启动（T6） |
| 旁观者「注视」待机动作 | **暂缓** | 需新动作素材；先做观战上下文/问答（T7 其余项照做） |
| 酒馆回复朗读 | **做，但默认关** | 设置项，用户自选；复用现有 TTS（T5） |
| i18n | **不做** | 单语言个人项目，沿用硬编码中文 |
| 会员 / SVIP / 充值视觉 | **不做** | 截图里的这些标签一律不引入 |

---

## 七、风险与坑（开工必看）

1. **数据层选型（已定）**：用 Electron 内置 `node:sqlite`，**不用 better-sqlite3**。
   - 依据：本机 Electron 44.9.0 内置 **Node 24.22.0**，实测 `require('node:sqlite').DatabaseSync`
     建表 / 增 / 查均正常、无需 `--experimental-sqlite` 开关。
   - 好处：**零 native 模块**，现有 `electron-builder.yml` 的 `npmRebuild: false` 完全不用动，
     不需要 VS 构建工具，打包不会有 ABI 不匹配（better-sqlite3 正是踩这个坑）。
   - 注意：`node:sqlite` 在 Node 24 仍标为**实验性** API（可能随 Electron 升级变动），升级 Electron 时
     回归一次；只有同步 API（主进程用正合适）。
   - 为何不选 better-sqlite3：需针对 Electron ABI 重建或找预编译包，而我们刻意关掉了 `npmRebuild`，
     徒增打包风险，收益（性能）在单机单用户规模下可忽略。若哪天 `node:sqlite` 出问题，退路是纯 JS 的
     `sql.js`（wasm，慢但零 native）。
2. **`sharp` 只在 devDependencies**：T1 若在主进程运行时用 sharp 生成缩略图，需转为运行时依赖并处理
   打包（sharp 同样是 native，有平台包）。**更省的选择**：缩略图交给渲染层 CSS 缩放原图，
   主进程不碰 sharp。
3. **`ELECTRON_RUN_AS_NODE`**：跑 Electron 前必须 `unset`（CLAUDE.md §八），否则主进程 `require('electron')`
   返回字符串路径。新的 `npm run dev` 验证同样受影响。
4. **native 钩子退出清理**：项目已有先例（`uiohook` 退出崩溃）。SQLite 连接在 `will-quit` 里 `close()`
   （WAL 模式下不 close 可能留 `-wal`/`-shm`），否则可能留下锁文件。
5. **不要把酒馆 IPC 混进 `chat:*`**：桌宠的 `chat:*` 通道有 `sendGeneration` / 单例 session / 桌宠气泡绑定；
   酒馆必须用独立的 `tavern:*` 通道与 `#tavern` 窗口，否则两条流会串。
6. **消息树从第一天建**：T2 再做分支会返工（insight 已提醒，这里再强调）。
7. **鲸鱼娘旁观只读**：`spectator.ts` 不得写 `tavern.db`，也不得把观战内容写进她自己的 `memory.json`
   （避免两套记忆互相污染）。
8. **打包体积**：现有安装包已 353MB（231MB 素材）。酒馆新增的卡图/背景会继续涨；T1 的卡图缩略图
   控制尺寸，背景图不入包（用户自选）。

---

## 八、里程碑与排期建议

| 里程碑 | 内容 | 累计估 |
|---|---|---|
| M-A（MVP） | T0 + T1 + T2：能导入卡、聊起来、能重生成/分支 | ~6–8 天 |
| M-B | T3 + T4：记忆三层 + 世界书/正则/预设/回复设置 | ~6–7 天 |
| M-C | T5 + T8：外观/通用 + 群聊 | ~3–4 天 |
| M-D（差异化） | T7：鲸鱼娘旁观者 | ~3 天 |
| M-E（暂缓） | T6：配图（用户拍板暂不做） | ~1–2 天 |
| M-F | T9：备份/引导/发布 | ~2–3 天 |

**建议起手顺序**：T0 → T1 → T2（先跑通「多角色聊天」这条主脊），再按 M-B→M-D。每一步都可独立验收，
不要一次做多个阶段（延续 CLAUDE.md「一次一个模块」约定）。

---

## 九、与 insight 附录 A 的对照（差异摘要）

- 「SVIP 付费墙」→ 维持**不做**（与「全免费差异化」一致）。
- 「账号/邀请」→ **砍**。
- 「底部五 tab 的『连接』」→ **砍**（重排为 4 项）。
- 「桌宠本体（阶段 8）」「语音设置页」→ **已完成**，本文件不重列。
- 其余功能（角色卡/聊天/记忆/世界书/正则/状态栏/文风/预设/回复/外观/配图/旁观者/群聊/备份）
  → 映射到 T1–T9。
