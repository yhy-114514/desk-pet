# P1 核心动作组 · 生成提示词（即梦 / Doubao）

> 用途：把下面的提示词逐条复制到「即梦 / Doubao」的**图生视频**，参考图**统一上传 `assets/ref-whale-maid.png`**。生成后把视频放到 `assets/p1-<组>/` 交回，我来跑抽帧管线。
>
> 本批需生成 **6 段视频**（均已交回并落地）：`yawn_normal.mp4`（打哈欠）、`done_normal.mp4`（翻白眼）、`drag_normal.mp4`（被拖住挣扎）、`eat_normal.mp4`（进食）、`sleep_normal.mp4`（睡觉）、`awake_normal.mp4`（觉醒）。
> 其中 drag / eat / sleep / awake 四段在抽帧时各拆成 `*_enter` / `*_normal` / `*_exit` 三段（持续态可循环），详见 `P1_photo_update.md`。
> `idle_normal` / `idle_blink` / `talk_normal` / `happy_normal` / `swim_normal` / `swim_enter` / `swim_exit` / `sad_normal` 已落地，本批不动。
>
> **P2 第三批（随机动作池补全，4 段视频已交回并落地）**：见文末「第三批」小节。

## 参考图

- 文件：`assets/ref-whale-maid.png`（从 happy 视频第 1 帧提取：Q 版蓝鲸娘标准站姿、纯白背景）。
- **每次生成都固定上传这一张**，保证角色脸型 / 发型 / 服装 / 鲸尾 / 呆毛完全一致。

## 角色锚点（即梦会根据参考图自动保持，无需重复描述）

Q 版三头身蓝色鲸鱼娘：深海蓝渐变长发 + 头顶一根呆毛 + 白色蕾丝女仆发箍 + 深蓝底白色围裙女仆装 + 背后一条厚实鲸鱼尾巴，表情呆萌可爱。

## 通用规避条款

纯白背景、1:1 方形、全身入镜、角色居中且不水平位移、头顶呆毛与鲸尾完整不被裁切、四周留白。

## 过渡与循环约定（重要）

- 所有动作的**起始帧 = 结束帧 = 参考图的站立姿态**，这样任意动作之间都能通过「站姿」无缝切换。
- 动作类视频要求首尾动作一致、可无缝循环；播放端还会在循环接缝做淡化，但源视频越接近首尾一致效果越好。
- `swim_enter` / `swim_exit` 是**一次性过渡**，只播一次，不要求循环。

---

> 第 1–4 组已落地，保留作提示词模板；**本批只需生成第 5–10 组**。

### 1. idle_blink —— 眨眼（图生视频，循环）

保持参考图角色形象完全不变，固定机位、角色居中、不水平位移。角色安静站立，双眼自然眨一下（缓缓闭眼→短暂闭合→再睁开），眨眼轻柔自然；眨眼间隙身体基本静止，仅鲸尾轻微摆动。起始与结束都回到参考图的站立姿态，首尾一致、可无缝循环。纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成 1–2 秒**（约 8–16 帧），放 `assets/p1-blink/idle_blink.mp4`。

---

### 2. sad_normal —— 失落（图生视频，循环）

保持参考图角色形象完全不变，固定机位、角色居中、不水平位移。角色从站立姿态开始慢慢失落：头微微低下、肩膀塌下、眼角下垂、嘴角下撇、鲸尾无力垂下，停顿片刻后再缓缓恢复到站立姿态。起始与结束都回到参考图的站立姿态，首尾一致、可无缝循环。纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成 3–4 秒**（约 24–32 帧），放 `assets/p1-sad/sad_normal.mp4`。

---

### 3. swim_enter —— 游动·进场（图生视频，一次性）

保持参考图角色形象完全一致。角色从参考图的站立姿态开始，双脚缓缓离地、身体前倾，逐渐过渡到漂浮游动姿态（双腿后收、双臂前伸、鲸尾摆起），最终停在游动姿态。**一次性过渡动画，不是循环**。固定机位、角色居中、不水平漂移；纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成约 1 秒**（约 8 帧），放 `assets/p1-swim-enter/swim_enter.mp4`。

---

### 4. swim_exit —— 游动·退场（图生视频，一次性）

保持参考图角色形象完全一致。角色从漂浮游动姿态开始（双腿后收、双臂前伸、鲸尾摆动），身体缓缓立起、双脚落回地面，逐渐恢复到参考图的站立姿态。**一次性过渡动画，不是循环**。固定机位、角色居中、不水平漂移；纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成约 1 秒**（约 8 帧），放 `assets/p1-swim-exit/swim_exit.mp4`。

---

### 5. idle_yawn —— 打哈欠（图生视频，循环）

保持参考图角色形象完全不变，固定机位、角色居中、不水平位移。角色安静站立片刻后，缓缓抬起一只手捂住嘴打起哈欠：眼睛眯起、眼角挤出水光，身体微微后仰，然后放下手、缓缓回到站立姿态。起始与结束都回到参考图的站立姿态，首尾一致、可无缝循环。纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成 2–3 秒**（约 16–24 帧），放 `assets/p1-yawn/idle_yawn.mp4`。

---

### 6. idle_done —— 翻白眼（图生视频，循环）

保持参考图角色形象完全不变，固定机位、角色居中、不水平位移。角色从站立姿态开始，露出无语的「翻白眼」表情：眼珠向上翻、眼皮半垂，嘴角微微下撇、头略微一歪，停顿片刻后恢复成站立标准表情。起始与结束都回到参考图的站立姿态，首尾一致、可无缝循环。纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成 1–2 秒**（约 8–16 帧），放 `assets/p1-done/idle_done.mp4`。

---

### 7. drag_struggle —— 被拖住挣扎（图生视频，循环）

保持参考图角色形象完全一致。角色被从上方拎起、双脚离地悬空，四肢乱蹬挣扎：双臂挥舞、双腿踢动、鲸尾甩摆，表情慌张无奈、嘴张开喊叫。动作连续循环，首尾姿态接近。固定机位、角色居中、不水平漂移；纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**10fps 抽帧，生成 2–3 秒**（约 20–30 帧），放 `assets/p1-drag/drag_struggle.mp4`。

> ⚠️ 已生成的 `assets/p1-drag/drag_normal.mp4` 在「被拽起」与挣扎段把角色画得过高，**头顶呆毛被画幅上边缘裁掉**（抽帧后 6/9 + 36/36 帧顶部贴边）。重生成时须强调「角色被拎起后仍完整留在画幅内，头顶与呆毛上方保留明显留白，不要贴顶」。

---

### 8. eat_happy —— 进食（图生视频）

保持参考图角色形象完全一致。角色双手捧着一小块食物（小鱼干/点心）送到嘴边愉快地吃：鼓腮咀嚼、闭眼满足地笑、尾巴开心轻摆；吃完后缓缓回到站立姿态。起始与结束都回到参考图的站立姿态。固定机位、角色居中、不水平位移；纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**10fps 抽帧，生成 2–3 秒**（约 20–30 帧），放 `assets/p1-eat/eat_happy.mp4`。

---

### 9. sleep_normal —— 睡觉（图生视频，循环）

保持参考图角色形象完全一致。角色从站立姿态缓缓蹲下蜷缩、闭上眼睛入睡，身体随呼吸轻微起伏，尾巴蜷在身侧；可选择在头顶飘出小小的 Zzz 气泡。保持安静平稳的睡眠呼吸循环。起始与结束都回到参考图的站立姿态，首尾一致、可无缝循环。固定机位、角色居中、不水平位移；纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**6fps 抽帧，生成 3–4 秒**（约 18–24 帧），放 `assets/p1-sleep/sleep_normal.mp4`。

---

### 10. awake_normal —— 觉醒（图生视频）

保持参考图角色形象完全一致。角色从站立姿态开始，缓缓睁开眼睛、正视前方，表情从呆萌转为平静认真，身体保持静止不动，眼神逐渐变得锐利专注（瞳孔中的蓝色数据流光效由渲染端叠加，视频里只需表现「睁眼→凝视」的眼神变化），片刻后恢复站立姿态。固定机位、角色居中、不水平位移；纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成 2–3 秒**（约 16–24 帧），放 `assets/p1-awake/awake_normal.mp4`。

---

## 第三批：P2 随机动作池补全（4 组）

> 目的：behavior.md 的待机随机动作池写了 6 项，原只有眨眼（`idle_blink`）、打哈欠（`idle_yawn`）两项素材。本批补齐其余 4 项，均为 **8fps、one-shot**，播完回待机。
> 生成方式同前：参考图固定上传 `assets/ref-whale-maid.png`，纯白背景、1:1 方形、固定机位、角色居中不位移、全身入镜、首尾回到站姿。
> **已交回并落地（2026-10-21）**：源视频在 `assets/p1-{stretch,scratch,zone,mumble}/*_normal.mp4`，按 8fps 原速抽帧得 40 / 32 / 56 / 40 帧（生成时长 4–7 秒，比计划的 2–3 秒长，保留原速不裁）。

### 11. idle_stretch —— 伸懒腰

保持参考图角色形象完全不变，固定机位、角色居中、不水平位移。角色安静站立片刻后，双手慢慢举过头顶向上伸展，身体微微后仰、眼睛舒服地眯起、鲸尾向上舒展，停顿一下后双手缓缓放下、回到站立姿态。起始与结束都回到参考图的站立姿态，首尾一致、可无缝循环。纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成 2–3 秒**（约 16–24 帧），放 `assets/p1-stretch/idle_stretch.mp4`。

---

### 12. idle_scratch —— 挠头

保持参考图角色形象完全不变，固定机位、角色居中、不水平位移。角色从站立姿态开始，抬起一只手到后脑勺挠了挠，头微微歪向一侧、眉头轻皱露出困惑表情，挠两下后放下手、回到站立姿态。起始与结束都回到参考图的站立姿态，首尾一致、可无缝循环。纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成 2–3 秒**（约 16–24 帧），放 `assets/p1-scratch/idle_scratch.mp4`。

---

### 13. idle_zone —— 发呆看屏幕

保持参考图角色形象完全不变，固定机位、角色居中、不水平位移。角色从站立姿态开始，目光逐渐放空、望向画面斜上方（像在盯着电脑屏幕发呆），表情呆滞、身体微微前倾，偶尔缓慢眨眼一次，鲸尾无意识地轻轻摆动，片刻后眼神收回、回到站立姿态。起始与结束都回到参考图的站立姿态，首尾一致、可无缝循环。纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成 3–4 秒**（约 24–32 帧），放 `assets/p1-zone/idle_zone.mp4`。

---

### 14. idle_mumble —— 小声嘀咕

保持参考图角色形象完全不变，固定机位、角色居中、不水平位移。角色站立，嘴巴小幅开合像在小声自言自语，眉头微微皱着、眼神有点不服气，头轻轻左右晃动，说完后嘴闭上、回到站立标准表情。**不要生成任何文字或对话气泡**（气泡由渲染端叠加），只要嘴部与头部的小幅动作。起始与结束都回到参考图的站立姿态，首尾一致、可无缝循环。纯白背景、1:1 方形、全身入镜、呆毛和鲸尾完整、四周留白。

→ 目标：**8fps 抽帧，生成 2–3 秒**（约 16–24 帧），放 `assets/p1-mumble/idle_mumble.mp4`。

---

## 交回后的管线（我执行）

```bash
# 抽帧（fps 按组：idle 8、drag/eat 10、sleep 6、awake 8；--trim-frames 为源 24fps 帧号，b 不含）
node tools/extract-video.mjs assets/p1-yawn/yawn_normal.mp4  assets/p1-yawn/frames   8 idle_yawn  --trim-frames=14:106
node tools/extract-video.mjs assets/p1-done/done_normal.mp4  assets/p1-done/frames   8 idle_done  --trim-frames=16:88
# 被拖：站姿→拽起 / 悬空挣扎（循环）/ 放下→站姿
node tools/extract-video.mjs assets/p1-drag/drag_normal.mp4  assets/p1-drag/frames  10 drag_enter  --trim-frames=0:22
node tools/extract-video.mjs assets/p1-drag/drag_normal.mp4  assets/p1-drag/frames  10 drag_normal --trim-frames=22:108
node tools/extract-video.mjs assets/p1-drag/drag_normal.mp4  assets/p1-drag/frames  10 drag_exit   --trim-frames=108:9999
# 进食：站姿→闭眼期待 / 睁眼放光（循环，放慢 2×） / 饭筷入镜→吃→站姿
node tools/extract-video.mjs assets/p1-eat/eat_normal.mp4    assets/p1-eat/frames   10 eat_enter  --trim-frames=0:10
node tools/extract-video.mjs assets/p1-eat/eat_normal.mp4    assets/p1-eat/frames   12 eat_normal --trim-frames=10:16 --speed=0.5
node tools/extract-video.mjs assets/p1-eat/eat_normal.mp4    assets/p1-eat/frames   10 eat_exit   --trim-frames=16:9999
# 睡觉：站姿→蜷缩入睡 / 睡眠呼吸（循环）/ 揉眼→站姿
node tools/extract-video.mjs assets/p1-sleep/sleep_normal.mp4 assets/p1-sleep/frames 6 sleep_enter  --trim-frames=0:58
node tools/extract-video.mjs assets/p1-sleep/sleep_normal.mp4 assets/p1-sleep/frames 6 sleep_normal --trim-frames=58:68 --speed=0.5
node tools/extract-video.mjs assets/p1-sleep/sleep_normal.mp4 assets/p1-sleep/frames 6 sleep_exit   --trim-frames=68:9999
# 觉醒：站姿→数据流出现 / 数据流凝视（循环）/ 褪去→站姿
node tools/extract-video.mjs assets/p1-awake/awake_normal.mp4 assets/p1-awake/frames 8 awake_enter  --trim-frames=0:80
node tools/extract-video.mjs assets/p1-awake/awake_normal.mp4 assets/p1-awake/frames 8 awake_normal --trim-frames=80:118
node tools/extract-video.mjs assets/p1-awake/awake_normal.mp4 assets/p1-awake/frames 8 awake_exit   --trim-frames=118:9999
# 第三批：4 个待机随机动作（整段可用，不裁剪）
for g in stretch scratch zone mumble; do
  node tools/extract-video.mjs assets/p1-$g/${g}_normal.mp4 assets/p1-$g/frames 8 idle_$g
done

# 抠透明底（isnet-anime，一次跑完平铺到 p1-cut/）
for d in p1-yawn p1-done p1-drag p1-eat p1-sleep p1-awake p1-stretch p1-scratch p1-zone p1-mumble; do
  python tools/remove-bg.py assets/$d/frames assets/p1-cut
done

# 规范化（统一高度 441 + Lab 颜色向 happy_normal 对齐）
# SEGMENT_STATE：同一动作的 enter/normal/exit 一起处理，共享缩放/水平锚点/垂直基线，
# 否则各段按自身姿势归一化会让角色在切换时忽大忽小、上下跳。
for s in drag eat sleep awake; do
  TARGET_HEIGHT=441 SEGMENT_STATE=$s node tools/process-frames.mjs assets/p1-cut assets/sprites ${s}_ \
    > .tmp/process-${s}.log 2>&1
done
for g in idle_yawn idle_done idle_stretch idle_scratch idle_zone idle_mumble; do
  TARGET_HEIGHT=441 node tools/process-frames.mjs assets/p1-cut assets/sprites ${g}_ \
    > .tmp/process-${g}.log 2>&1
done

node tools/scan-frames.mjs && node tools/pack-atlas.mjs && node tools/build-hitmask.mjs
```

- 旧静态帧 `sprites/idle_blink/`、`sprites/sad_normal/` 在重跑前先清理，避免新旧帧混批。
- 角色大小 / 站位统一用 `TARGET_HEIGHT=441`（与 happy / idle / talk 基准一致）。
