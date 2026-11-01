import { Assets, Container, Sprite, Spritesheet, type SpritesheetData, type Texture } from 'pixi.js'
import manifest from '../../../assets/manifest.json'

// 每组一张 atlas（单张 4096 装不下所有帧），由 Vite 在构建期收集。
const ATLAS_JSON = import.meta.glob('../../../assets/atlas/*.json', {
  eager: true,
  import: 'default'
}) as Record<string, SpritesheetData>
const ATLAS_URL = import.meta.glob('../../../assets/atlas/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

// 切换动画组时的交叉淡化时长。不同视频源生成的角色姿势在接缝处仍有差异
// （实测跨组差异约 20–31，组内相邻帧约 5–15），硬切会「跳一下」；
// 160ms 只够盖住接缝，不会拖慢动作。
const GROUP_FADE_MS = 160

// 常驻纹理的帧数预算。每帧 512×512 RGBA = 1MB 显存/内存，27 组共 820 帧 ——
// 全量常驻实测让渲染进程吃到 950MB+。改成按需加载 + 超预算回收后只留最近用过的几组。
const FRAME_BUDGET = 128
// 多久检查一次预算（ms）。没必要每帧算
const EVICT_INTERVAL_MS = 5000

interface AnimationGroup {
  frames: string[]
  fps: number
  loop: boolean
  priority: number
  durations?: number[] // 可选：逐帧停留时长（ms），缺省按 fps 均匀
  fade?: number // 可选：帧间淡化时长占单帧时长的比例（0 = 硬切）；缺省 0
  loopFade?: number // 可选：循环「末帧→首帧」接缝的淡化比例；缺省 0（只作用于接缝）
}

/**
 * 数据驱动的帧动画播放器：帧列表/帧率全部来自 manifest.json，不硬编码帧名。
 * 视频抽帧组帧间本就连续，默认硬切（fade=0）；静态帧组可在 manifest 里设 fade 做过渡。
 */
export class Animator {
  readonly view = new Container()

  /** one-shot 组（loop:false）播到末帧时触发一次；由调度器接管后续切组 */
  onComplete?: (groupName: string) => void
  /**
   * 某一组**真正开始播**时触发。按需加载时 play() 会先返回、等纹理到位才开播，
   * 所以按「整组时长」计时的调用方（PetCore 的反应 / 一次性动作）要在这里重新对齐计时起点，
   * 否则计时从调用那一刻起跑，动画会被切掉一截甚至整段跳过。
   */
  onGroupStart?: (groupName: string) => void

  private readonly groups: Record<string, AnimationGroup>
  /** 每组的图集来源（json 描述 + png 地址），加载前就已就绪 */
  private readonly sources: Record<string, { data: SpritesheetData; url: string }> = {}
  /** 已加载的组：帧名 → 纹理。超出 FRAME_BUDGET 的旧组由 evict() 回收 */
  private readonly loaded = new Map<
    string,
    { textures: Record<string, Texture>; url: string; lastUsed: number }
  >()
  private readonly loading = new Set<string>()
  /** 等着加载完才能播的组（加载期间继续播当前动画，避免白屏） */
  private pendingGroup: string | null = null
  /** 上一组：交叉淡化期间 back 层还引用着它的纹理，不能提前回收 */
  private previousGroup = ''

  /** 当前组已加载的纹理表（currentGroup 对应的那一份） */
  private current: { textures: Record<string, Texture>; url: string; lastUsed: number } | null = null

  private readonly front = new Sprite()
  private readonly back = new Sprite()

  private evictTimer = 0
  private groupName = ''
  private frames: string[] = []
  private durations: number[] | null = null
  private fps = 8
  private index = 0
  private frameTime = 0
  private fadeTime = 0
  private fadeDuration = 0
  private fadeRatio = 0
  private loopFadeRatio = 0
  private loop = true
  private completed = false

  private constructor(groups: Record<string, AnimationGroup>) {
    this.groups = groups

    this.back.alpha = 0
    this.view.addChild(this.back, this.front)
    // 帧与画幅同尺寸，中心对齐；定位交给 view（pivot/scale/position）
    this.front.anchor.set(0.5)
    this.back.anchor.set(0.5)
    this.front.position.set(256, 256)
    this.back.position.set(256, 256)
  }

  /**
   * 建好播放器并预加载 `preload` 里的组；其余组等真正播到再加载。
   * 返回值前必须至少有一组就绪，否则第一帧没有东西可画。
   */
  static async create(preload: string[] = []): Promise<Animator> {
    const animator = new Animator(manifest.groups)
    for (const [jsonPath, data] of Object.entries(ATLAS_JSON)) {
      const group = jsonPath.match(/([^/]+)\.json$/)?.[1]
      const url = group ? ATLAS_URL[jsonPath.replace(/\.json$/, '.png')] : undefined
      if (!group || !data || !url) throw new Error(`atlas 不完整: ${jsonPath}`)
      animator.sources[group] = { data, url }
    }
    await Promise.all(preload.map((group) => animator.ensureLoaded(group)))
    return animator
  }

  /** 加载某一组的图集；同一组重复请求只会加载一次。 */
  private async ensureLoaded(groupName: string): Promise<void> {
    if (this.loaded.has(groupName) || this.loading.has(groupName)) return
    const source = this.sources[groupName]
    if (!source) return
    this.loading.add(groupName)
    try {
      const texture = await Assets.load<Texture>(source.url)
      const sheet = new Spritesheet(texture, source.data)
      await sheet.parse()
      this.loaded.set(groupName, {
        textures: sheet.textures,
        url: source.url,
        lastUsed: performance.now()
      })
    } catch (error) {
      console.error(`[animator] 加载动画组 ${groupName} 失败`, error)
    } finally {
      this.loading.delete(groupName)
    }
    // 加载期间请求过播放的话，这时候补上；加载失败就把等待标记清掉，下次还愿意重试
    if (this.pendingGroup === groupName) {
      this.pendingGroup = null
      if (this.loaded.has(groupName)) this.play(groupName)
    }
  }

  /**
   * 按帧数预算回收最久没用的组。当前组、正在淡出的上一组、等待加载的组都不动。
   * 纹理销毁后 GPU 与进程内存都能还回去；需要时再按需加载。
   */
  private evict(): void {
    const keep = new Set<string>([this.groupName, this.previousGroup, this.pendingGroup ?? ''])
    const entries = [...this.loaded.entries()]
    let frames = entries.reduce((sum, [name]) => sum + (this.groups[name]?.frames.length ?? 0), 0)
    if (frames <= FRAME_BUDGET) return

    const candidates = entries
      .filter(([name]) => !keep.has(name))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [name, entry] of candidates) {
      this.loaded.delete(name)
      void Assets.unload(entry.url).catch(() => {})
      frames -= this.groups[name]?.frames.length ?? 0
      if (frames <= FRAME_BUDGET) break
    }
  }

  /** 可供轮播/状态机查询的组名 */
  get groupNames(): string[] {
    return Object.keys(this.groups)
  }

  /** 当前播放的组名（点击命中掩码按组取用） */
  get currentGroup(): string {
    return this.groupName
  }

  /** 当前显示帧的下标（点击命中掩码按帧取用） */
  get currentFrameIndex(): number {
    return this.index
  }

  /** 组的完整循环时长（ms）；状态机判断「动画播完」时用 */
  groupDuration(groupName: string): number {
    const group = this.groups[groupName]
    if (!group) return 0
    return group.frames.reduce((sum, _, i) => sum + this.durationOfGroup(group, i), 0)
  }

  private durationOfGroup(group: AnimationGroup, index: number): number {
    return group.durations?.[index] ?? 1000 / group.fps
  }

  /**
   * 预热某一组（不等加载完成）。分段动作进入段通常有 1–2s，足够把下一段解码出来；
   * 不预热的话 enter 播完会卡在末帧（one-shot 播完就停在最后一帧）等图集加载。
   */
  preload(groupName: string): void {
    void this.ensureLoaded(groupName)
  }

  /**
   * 该组是否正在加载（已请求、尚未就绪）。
   * 加载失败后返回 false——调用方据此区分「再等等」和「等不到了」，避免无限等待。
   */
  isLoading(groupName: string): boolean {
    return this.loading.has(groupName) && !this.loaded.has(groupName)
  }

  play(groupName: string): void {
    const group = this.groups[groupName]
    if (!group || group.frames.length === 0) return
    const asset = this.loaded.get(groupName)
    if (!asset) {
      // 这组还没加载：先把加载挂上，期间继续播当前动画。加载完 ensureLoaded 会回头再调一次 play
      if (this.pendingGroup !== groupName) {
        this.pendingGroup = groupName
        void this.ensureLoaded(groupName)
      }
      return
    }
    // 中途又切到别的组：之前挂着的等待作废，否则它加载完会把画面抢回去
    if (this.pendingGroup && this.pendingGroup !== groupName) this.pendingGroup = null
    // 组间切换：旧组的当前帧留在 back 层淡出，避免姿势差异造成的硬跳。
    // 首次播放（尚无当前组）不做淡化。
    const previousTexture = this.groupName ? this.front.texture : null
    if (this.groupName && this.groupName !== groupName) this.previousGroup = this.groupName
    this.current = asset
    asset.lastUsed = performance.now()
    this.groupName = groupName
    this.frames = group.frames
    this.durations = group.durations ?? null
    this.fps = group.fps
    this.fadeRatio = group.fade ?? 0
    this.loopFadeRatio = group.loopFade ?? 0
    this.loop = group.loop
    this.index = 0
    this.frameTime = 0
    this.completed = false
    this.fadeTime = 0
    this.fadeDuration = previousTexture ? GROUP_FADE_MS : 0
    this.front.texture = asset.textures[group.frames[0]]
    this.front.alpha = 1
    this.back.texture = previousTexture ?? this.front.texture
    this.back.alpha = previousTexture ? 1 : 0
    this.onGroupStart?.(groupName)
  }

  /** 第 index 帧的停留时长：优先用 manifest 的 durations，否则按 fps 均匀 */
  private durationOf(index: number): number {
    return this.durations?.[index] ?? 1000 / this.fps
  }

  update(deltaMs: number): void {
    this.evictTimer += deltaMs
    if (this.evictTimer >= EVICT_INTERVAL_MS) {
      this.evictTimer = 0
      this.evict()
    }
    // 当前组的纹理在回收时受保护，理论上不会是 null；真丢了就不要再动精灵
    if (!this.current) return
    if (this.frames.length < 2) return
    this.frameTime += deltaMs
    // 组间淡化进行中：back 层是上一组的帧，本组内换帧不能覆盖它
    const fadeActive = this.fadeDuration > 0 && this.fadeTime < this.fadeDuration

    while (this.frameTime >= this.durationOf(this.index)) {
      // 一次性过渡组播完停在末帧，不循环；末帧停留满一帧时通知调度器（只触发一次）
      if (!this.loop && this.index === this.frames.length - 1) {
        this.frameTime = 0
        if (!this.completed) {
          this.completed = true
          this.onComplete?.(this.groupName)
        }
        break
      }

      const prevIndex = this.index
      const duration = this.durationOf(prevIndex)
      const isWrap = prevIndex === this.frames.length - 1
      this.frameTime -= duration
      this.index = (this.index + 1) % this.frames.length

      if (!fadeActive) {
        // 循环接缝（末帧→首帧）单独用 loopFade，抹平视频首尾不一致的跳变；
        // 其余帧间仍用 fade（视频组为 0，硬切）。
        const fadeRatio = isWrap ? this.loopFadeRatio : this.fadeRatio
        // 旧帧放到 back 层淡出，新帧直接显示（避免两帧同时半透明透出桌面）
        this.back.texture = this.current.textures[this.frames[prevIndex]]
        this.back.alpha = fadeRatio > 0 ? 1 : 0
        // 过渡时长按较短的那帧算：眨眼帧只有 160ms，不能拖成 1s 的慢睁眼
        this.fadeTime = 0
        this.fadeDuration = Math.min(duration, this.durationOf(this.index)) * fadeRatio
      }
      this.front.texture = this.current.textures[this.frames[this.index]]
      this.front.alpha = 1
    }

    if (this.fadeDuration > 0) {
      this.fadeTime = Math.min(this.fadeDuration, this.fadeTime + deltaMs)
      this.back.alpha = 1 - this.fadeTime / this.fadeDuration
      if (this.fadeTime >= this.fadeDuration) {
        this.fadeTime = 0
        this.fadeDuration = 0
        this.back.alpha = 0
      }
    }
  }
}
