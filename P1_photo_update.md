# P1 素材清单 · 第一批（视频抽帧）

> 本文件是 Claude Code 处理 P1 素材的**唯一源清单**。开工时先读本文件 + `assets-spec.md`。

## 〇、方案：动作帧一律改用「视频抽帧」

逐帧生图（每组 2 张静态图 + 程序补间）帧数太少、帧间不衔接，导致抽搐，**已废弃**——旧的源图 / 抠图 / sprite 已全部清理删除。正解是把动作做成连续视频再抽帧：帧与帧之间天然衔接，动作可复杂、丝滑。

- 生成方式：以 Q 版设定图母版为参考做图生视频（**固定机位、角色居中不位移、纯白背景、动作循环**），再抽帧成 sprite。
- 已落地样例：**开心组**（见第一节）。
- 核心组已补齐：**idle_normal / idle_blink / talk_normal / swim_normal / sad_normal**（见第二节），均已接入 manifest 与 atlas。
- 第二批六段视频已落地（见「二·补」）：yawn / done 各一组，drag / eat / sleep / awake 各拆 enter / normal / exit 三段，P1 素材至此 22 组齐备。

## 一、开心组（视频抽帧 · 已落地，可直接用）

- 源视频（动作预览）：`https://aka.doubaocdn.com/s/c4tyqObk18`（6.08 秒，1:1，720×720，白底，24fps）
- 已落地抽帧：`assets/p1-happy/frames/happy_normal_01.png` ~ `happy_normal_48.png`（48 帧 @ **8fps**，720×720 白底 PNG）
- 动作循环：待机 → 起跳欢呼 → 腾空 → 落地 → 回待机（Loop 首尾一致）
- 处理管线（当前实际命令）：

```bash
# 0) 取源视频（已下载则跳过）
mkdir -p assets/p1-happy
curl -L --fail -o assets/p1-happy/happy.mp4 "https://aka.doubaocdn.com/s/c4tyqObk18"

# 1) ffmpeg 抽帧 @ 8fps -> happy_normal_01..48.png（ffmpeg-static 免安装系统 ffmpeg）
node tools/extract-video.mjs assets/p1-happy/happy.mp4 assets/p1-happy/frames 8 happy_normal

# 2) rembg 抠透明底（输出平铺到 assets/p1-cut/）
python tools/remove-bg.py assets/p1-happy/frames assets/p1-cut

# 3) 去白边/去噪/统一 512/整组统一锚点 -> assets/sprites/happy_normal/
#    末尾 happy_ 为可选前缀过滤：只处理本组，避免不同来源的帧混入统一缩放
node tools/process-frames.mjs assets/p1-cut assets/sprites happy_

# 4) 打包 sprite sheet + 生成 manifest.json + 点击命中掩码
node tools/scan-frames.mjs
node tools/pack-atlas.mjs
node tools/build-hitmask.mjs
```

- ⚠️ **抠图模型**：必须用 **isnet-anime**（rembg 的动漫角色专用模型）。通用 u2net 会把发间空隙填成白色硬块、并把脚底白地面/阴影误判为主体；isnet-anime 对发丝与空隙分割明显更好。角色服装含大量白色，**禁止用纯色键 / 色差阈值抠白**（会误伤围裙、蕾丝边、白袜）。
- **空隙去白**：`remove-bg.py` 里 `clear_background_whites()` 会在抠图后把「贴画幅外框的白色」和「被发丝包围的平坦白色空隙」置透明。空隙判据是白色连通块的**亮度均值 ≥ 244**（白底约 249，而围裙/蕾丝/白袜带明暗渐变，均值约 235-243），因此衣着白色不受影响。若某组出现残留白块或白料被误删，调 `GAP_MEAN_LUM` 即可。
- **缩放与溢出**：`process-frames.mjs` 按整组「最高头顶 → 最低脚底」的总跨度算统一 scale（不是中位帧高度），保证腾空帧头顶不溢出 512 画幅；日志中若出现 `超出画幅` 会直接报错。
- 播放：48 帧按 8fps 播放 = 6 秒一个完整循环；视频组 manifest 不设 `fade`（硬切），帧间连续无需交叉淡化。
- 抽更密：把抽帧 fps 从 8 提到 12（约 72 帧），同时把 `scan-frames.mjs` 中 `FPS_BY_STATE.happy` 改为 12。
- ⚠️ **已知**：该源视频角色自身有约 6% 画幅的缓慢左右漂移（生成时未完全锁住机位）。管线用「整组统一锚点」原样保留这项运动，不做逐帧强行居中（强行居中会引入抖动）。后续组生成时请在提示词中强调「固定机位、角色中心不水平位移」。
- ⚠️ **已知（待重生成）**：该源视频跳起到最高点时，角色头顶贴到画幅顶边，**呆毛尖端在源视频里已被截断**（源图 y=0 处 alpha≈115，尖端像素丢失），管线无法还原。重生成视频时须「角色居中、四周留白、头顶不贴边」，再重跑本管线。

## 二、核心五组（已落地）

> 提示词见 `P1_prompts.md`；参考图固定为 `assets/ref-whale-maid.png`（happy 第 1 帧）。

| 组 | 源素材 | 帧数 | fps | 循环 | 说明 |
|---|---|---|---|---|---|
| `idle_normal` | `assets/p1-idle/idle_normal.mp4`（4.06s） | 32 | 8 | 4.00s | 呼吸 + 鲸尾轻摆 |
| `talk_normal` | `assets/p1-talk/talk_normal.mp4`（4.06s） | 49 | 12 | 4.08s | 口型开合 |
| `swim_normal` | `assets/p1-swim/swim_normal_update.mp4`（6.08s） | 48 | 8 | 6.00s | v2 提示词：双脚离地、尾巴大幅 S 形摆动 |
| `idle_blink` | `assets/p1-blink/idle_blink_update.mp4`（10.06s，取第 12–46 帧并 1.5×） | 8 | 8 | 0.70s（one-shot） | 单次眨眼；逐帧 `durations` 非对称（闭眼快、睁眼慢），待机随机触发 |
| `sad_normal` | `assets/p1-sad/sad_normal_update.mp4`（8.06s，2×） | 32 | 8 | 4.00s | 失落表情进出，源时长压缩一半 |
| `swim_enter` | `assets/p1-swim-enter/swim_enter.mp4`（源 `swim_normal_before.mp4`，取第 0–60 帧并 2×） | 10 | 8 | 1.25s（one-shot） | 站姿→漂浮游动，`loop:false` |
| `swim_exit` | `assets/p1-swim-exit/swim_exit.mp4`（源 `swim_normal_after.mp4`，取第 0–60 帧并 2×） | 10 | 8 | 1.25s（one-shot） | 漂浮游动→站姿，`loop:false` |

- **统一角色高度**：处理时设 `TARGET_HEIGHT=441`，按角色中位 bbox 高度归一，保证切换动画时角色不变大变小。
- **统一站位（2026-10-20 修正）**：水平锚点改为「组内各帧**头部中心** x 的中位数」对齐到画幅中心，最低帧贴画幅底边。原先用「最接地帧的脚部中心」会被垂到画面底部的鲸尾带偏：实测 `swim_normal` 右偏约 55px、`sad_normal` 左偏约 38px，跨组切换时角色会横跳。头部是 Q 版角色最稳定的身体轴线；取中位数可排除眨眼/跳跃的瞬时偏移。个别尾巴甩到最右的帧会夹回画幅内（日志 `右侧越界`），避免裁掉尾巴。
- **过渡与循环**：所有动作首尾都回到样例站姿，任意动作可经站姿衔接；`swim_normal` 是持续游动态，额外用 `swim_enter` / `swim_exit` 两条一次性过渡进出。`swim_enter` 末帧与 `swim_normal_01`、`swim_exit` 首帧与 `swim_normal_48` 的高度已对齐（bottom 463/465、488/487）。
- **循环接缝**：视频生成的首尾并不严格一致，manifest 对视频组设 `loopFade: 0.75`，只在「末帧→首帧」做淡化，不裁帧。
- **豆包超时长**：AI 生成的视频普遍长于提示词（眨眼 10s、失落 8s、过渡各 4s）。`extract-video.mjs` 新增 `--trim-frames=a:b` / `--speed=N`，先裁再变速，抽帧数控制在 8–32 帧。
- **跨组颜色统一（2026-10-20）**：豆包独立生成的各组视频有白平衡/亮度偏差（实测亮度差约 3、蓝色饱和度差约 3），切换动作时会跳色。`process-frames.mjs` 在 Lab 空间把每组角色像素的均值平移到基准组 `happy_normal`（可用 `COLOR_REF_GROUP` 覆盖），只平移均值、不缩标准差，保留组内对比。匹配后 8 组 Lab 均值偏差 < 0.1。
- **旧静态组**：`sprites/idle_blink`、`sprites/sad_normal` 的旧静态帧已清除并换成视频抽帧，避免新旧帧混批（原始静态图仍保留在 `assets/p1-blink/`、`assets/p1-sad/`）。

各组的实际处理命令：

```bash
# 抽帧（fps 按组约定：idle/swim 8，talk 12）
node tools/extract-video.mjs assets/p1-idle/idle_normal.mp4 assets/p1-idle/frames 8 idle_normal
node tools/extract-video.mjs assets/p1-talk/talk_normal.mp4 assets/p1-talk/frames 12 talk_normal
node tools/extract-video.mjs assets/p1-swim/swim_normal_update.mp4 assets/p1-swim/frames 8 swim_normal
# 豆包超时长的四组：先裁帧/变速再抽帧
node tools/extract-video.mjs assets/p1-blink/idle_blink_update.mp4 assets/p1-blink/frames 8 idle_blink --trim-frames=12:47 --speed=1.5
node tools/extract-video.mjs assets/p1-sad/sad_normal_update.mp4 assets/p1-sad/frames 8 sad_normal --speed=2
node tools/extract-video.mjs assets/p1-swim-enter/swim_enter.mp4 assets/p1-swim-enter/frames 8 swim_enter --trim-frames=0:61 --speed=2
node tools/extract-video.mjs assets/p1-swim-exit/swim_exit.mp4 assets/p1-swim-exit/frames 8 swim_exit --trim-frames=0:61 --speed=2

# 抠透明底（可一次跑完，输出平铺到 p1-cut/）
for d in p1-idle p1-talk p1-swim p1-blink p1-sad p1-swim-enter p1-swim-exit; do
  python tools/remove-bg.py assets/$d/frames assets/p1-cut
done

# 规范化（每组单独跑，前缀过滤；统一角色高度 441px）
for g in happy_normal idle_normal talk_normal swim_normal swim_enter swim_exit idle_blink sad_normal; do
  TARGET_HEIGHT=441 node tools/process-frames.mjs assets/p1-cut assets/sprites ${g}_ \
    > .tmp/process-${g}.log 2>&1
done

node tools/scan-frames.mjs && node tools/pack-atlas.mjs && node tools/build-hitmask.mjs
```


- **atlas 已改为每组一张**：`assets/atlas/{group}.png` + `{group}.json`（单张 4096² 只能放 49 帧，装不下全部组）。
- 开发期动作预览面板：`npm run dev` 时自动弹出小窗，可逐组切换动作/恢复自动轮播（仅开发模式创建，后续由状态机/互动触发替代）。

## 二·补、第二批六视频 → 14 组（2026-10-21 落地）

> 四个「整流程」动作（drag / eat / sleep / awake）按状态切成 `*_enter`（进入，one-shot）→ `*_normal`（持续，循环）→ `*_exit`（退出，one-shot）三段；后半段由状态持续多久决定，循环段可无限播放。切分点由源视频逐帧目检确定（源 24fps，`--trim-frames` 的结束帧不含）。

| 组 | 源视频 | 裁剪（源帧） | 帧数 | fps | 循环 | 时长 |
|---|---|---|---|---|---|---|
| `idle_yawn` | `assets/p1-yawn/yawn_normal.mp4` | 14–106 | 31 | 8 | one-shot | 3.88s |
| `idle_done` | `assets/p1-done/done_normal.mp4` | 16–88 | 24 | 8 | one-shot | 3.00s |
| `drag_enter` | `assets/p1-drag/drag_normal.mp4` | 0–22 | 9 | 10 | one-shot | 0.90s |
| `drag_normal` | 同上 | 22–108 | 36 | 10 | 循环 | 3.60s |
| `drag_exit` | 同上 | 108–末尾 | 55 | 10 | one-shot | 5.50s |
| `eat_enter` | `assets/p1-eat/eat_normal.mp4` | 0–10 | 4 | 10 | one-shot | 0.40s |
| `eat_normal` | 同上 | 10–16（`--speed=0.5`） | 6 | 12 | 循环 | 0.50s |
| `eat_exit` | 同上 | 16–末尾 | 94 | 10 | one-shot | 9.40s |
| `sleep_enter` | `assets/p1-sleep/sleep_normal.mp4` | 0–58 | 15 | 6 | one-shot | 2.50s |
| `sleep_normal` | 同上 | 58–68（`--speed=0.5`） | 5 | 6 | 循环 | 0.83s |
| `sleep_exit` | 同上 | 68–末尾 | 25 | 6 | one-shot | 4.17s |
| `awake_enter` | `assets/p1-awake/awake_normal.mp4` | 0–80 | 27 | 8 | one-shot | 3.38s |
| `awake_normal` | 同上 | 80–118 | 13 | 8 | 循环 | 1.63s |
| `awake_exit` | 同上 | 118–末尾 | 9 | 8 | one-shot | 1.13s |

- **切分依据**：
  - drag：帧 22 双脚完全离地被拎起；帧 108 身体开始下落（放下）。
  - eat：帧 10 睁眼放光（期待态起点），该态仅 6 帧且几乎静止，用 `--speed=0.5` 放慢到 0.5s 循环；帧 16 大白饭与筷子入镜。
  - sleep：帧 42 已坐下并闭眼，42–58 还有缓慢沉下/调整的余势；为保证循环自然，进入段取到 58（完全稳定的睡姿），58–68 用 `--speed=0.5` 放慢成 0.83s 呼吸循环；帧 68 手开始抬起（揉眼）。
  - awake：帧 80 眼中蓝色数据流稳定显形（此前 60–76 为渐入）；帧 118 数据流开始褪去。
- **循环段首尾**：四个 `*_normal` 的首末帧已目检过（drag 悬空姿势一致；eat 期待态近乎静止；sleep 身体姿势一致、仅 Zzz 气泡大小略变；awake 首末均有数据流），manifest 统一 `loopFade: 0.75` 抹平残余差异。
- **一次性段**：`idle_yawn` / `idle_done` / 四个 `*_enter` / 四个 `*_exit` 全部 `loop:false`，播完停末帧，由状态机接管后续切换。
- **分段共享归一化**：`process-frames.mjs` 新增 `SEGMENT_STATE=<state>`，把同动作的三段当一批处理，共享缩放（以 `*_enter_01` 站姿帧高度为基准）、水平锚点与垂直基线。分段各自归一化时，拖拽悬空（腿收起）、睡觉蜷缩等姿势会让 bbox 高度变化，切换瞬间角色会忽大忽小（实测 9–16%）。
- **左侧越界裁剪**：吃播中饭碗/手从画外入镜会把 bbox 左侧撑出画幅，原先直接报错；现在裁掉画外部分而非整帧右移，保证角色头部仍在画幅中心。
- ⚠️ **已知（待重生成）**：`drag_normal.mp4` 里角色被拎起后头顶贴到画幅上边缘，**呆毛被源视频裁掉**（`drag_enter` 6/9 帧、`drag_normal` 36/36 帧顶部贴边），管线无法还原。重生成时强调「角色始终完整在画幅内、头顶留白」。

命令见 `P1_prompts.md` 末尾「交回后的管线」。

## 三、动画消费约定（PixiJS 侧）

- 视频组帧间连续，manifest 不设 `fade`（硬切）；循环接缝用 `loopFade` 淡化（视频首尾不一致时抹平跳变）。
- **组间切换**：Animator 内置 `GROUP_FADE_MS = 160` 交叉淡化——切换组时把旧组当前帧留在 back 层淡出。不同视频源在接缝处姿势仍有差异（实测跨组像素差 20–31，组内相邻帧仅 5–15），硬切会「跳一下」；160ms 只盖住接缝，不拖慢动作。`loopFade` 仍只作用于单组循环的接缝，两者互不影响。
- **眨眼节奏与随机性**：`idle_blink` 是 one-shot（`loop:false`），manifest 用逐帧 `durations` 做非对称节奏（90/80/60/60/60/70/120/160ms，共 0.70s）：帧 2–6 闭眼快、帧 7–8 睁眼慢，模仿真人。`idleBlink.ts` 在待机（`idle_normal`）播放时按随机间隔 2–8s 插播一次，约 10% 概率连眨两下；`Animator.onComplete` 在 one-shot 末帧播完时通知调度器回待机。
- `loop:false` 的组（`swim_enter` / `swim_exit` / `idle_blink` / `idle_yawn` / `idle_done`，以及 drag/eat/sleep/awake 的 `*_enter` / `*_exit`）播完停在末帧，供状态机接着切到目标动作。
- 分段状态的播放约定：`*_enter` 播完由 `onComplete` 切 `*_normal`（无限循环）；离开状态时插 `*_exit`，播完回 `idle`。
- 帧命名即 manifest 的 key，代码**只读 manifest.json**，禁止硬编码帧名。
- **点击穿透**：`assets/hitmask.json` 存每组**逐帧**的 1-bit 掩码（base64，下标与 manifest 帧序一致）。渲染进程用 `pet.toLocal()` 把鼠标坐标换回 512 画幅，查当前帧掩码：命中角色像素才关闭 `setIgnoreMouseEvents`，透明区（含发丝/尾巴间空隙）点击穿透到桌面。
- 剩余组（eat / sleep / drag / awake / yawn / done 等）由同一视频管线补充生成；每个动作首尾都回到样例站姿，保证切换丝滑。

## 四、来源与血缘

- 母版：Q 版蓝色鲸鱼娘设定图（身份锚点）。全部帧衍生自该母版，角色特征须保持一致。
- 画布资产目录（Agent 侧）：`/core-assets/whale-maid/derivatives/p1-frames`，如需核对原始记录可查。
