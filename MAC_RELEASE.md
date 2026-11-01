# macOS 发布说明

Windows 安装包用 `npm run dist`，macOS 走 GitHub Actions —— **dmg 只能在 macOS 上构建**，
Windows 上没有 `hdiutil`，electron-builder 会直接拒绝（实测报
`Build for macOS is supported only on macOS`）。

---

## 一、怎么出包（给维护者）

### 自动：推一次快照并打 tag

```bash
cd /d/AI_Working/desk_pet
bash tools/publish-github.sh https://github.com/你的用户名/desk-pet.git 0.1.0
```

`.github/workflows/build-mac.yml` 会跑完类型检查 + 693 例单测，然后产出两个 dmg
并挂到 GitHub Release 上。Release 页面直接点就能下载，用户不用登录。

> **别随便 `git push origin v0.1.0`**：本地 git 根目录是 `D:/AI_Working`（同级还有
> finance_cli / claude_start），直推会把它们一起公开。发布一律走上面这个脚本，
> 它只导出 `desk_pet` 一份快照。新手步骤见 `GITHUB_SETUP.md`。

### 手动：Actions 页面点一下

仓库 → Actions → `build-mac` → `Run workflow`。
产物在本次运行的页面底部（Artifacts → `mac-dmg`），不会建 Release。

### 本地（如果你有 Mac）

```bash
npm ci
npm run dist:mac     # 产物在 release/
```

---

## 二、产物

| 文件 | 适用机器 |
|---|---|
| `desk-pet-0.1.0-mac-arm64.dmg` | Apple 芯片（M1 / M2 / M3 / M4） |
| `desk-pet-0.1.0-mac-x64.dmg` | Intel 芯片 |

体积各约 400MB，和 Windows 版同量级。

---

## 三、给 Mac 用户的安装步骤

**必须写进发布说明，否则用户会以为文件坏了。**

1. 下载对应芯片的 dmg（不确定就看「关于本机」→ 芯片/处理器）。
2. 双击 dmg，把「鲸鱼娘」拖进「应用程序」。
3. **第一次打开不要双击**：在「应用程序」里**右键（或按住 Control 点）→ 打开**，
   弹窗里再点一次「打开」。之后就能正常双击了。
   - 如果双击时提示「无法打开，因为 Apple 无法检查其是否包含恶意软件」，
     就是这个原因，不是文件损坏。
   - 嫌右键麻烦可以在终端跑一次：
     `xattr -dr com.apple.quarantine /Applications/鲸鱼娘.app`
4. 打开后她出现在屏幕右下角，菜单栏里多一只小鲸鱼（所有操作都在那儿）。

> 为什么会被拦：应用**没有 Apple 开发者签名**（需要 $99/年 的开发者账号）。
> 打包时只做了 ad-hoc 签名 —— Apple Silicon 上完全没签名的 app 会被系统直接
> 杀掉，所以这一步不能省，但它不等于「可信开发者签名」。

---

## 四、Mac 上的两项系统权限

| 权限 | 用途 | 怎么给 |
|---|---|---|
| **辅助功能** | 右键游动、进入游动后跟随鼠标（全局鼠标钩子 `uiohook`） | 托盘菜单「开启『辅助功能』权限…」→ 系统设置 → 隐私与安全性 → 辅助功能 → 勾上鲸鱼娘 |
| **麦克风** | 输入栏 🎤 语音输入 | 第一次点 🎤 时系统会弹窗，点「允许」 |

没给辅助功能权限时，钩子进程能起来但收不到任何事件，表现正好是
「右键没反应」而程序不报错 —— 所以托盘菜单在未授权时会多出那一项。

---

## 五、Mac 版和 Windows 版的差异

| 项目 | Windows | macOS |
|---|---|---|
| 常驻入口 | 系统托盘 | 菜单栏（图标是 Template 图，自动适配深浅色） |
| 任务栏 / Dock | `skipTaskbar`，不占 | 只挂桌宠时隐藏 Dock；开酒馆 / 配置 / 手账时自动出现 |
| 多桌面 | 无此概念 | 桌宠在所有 Space 与全屏应用上都可见 |
| 唤出输入栏 | Ctrl+Shift+Space | ⌘+Shift+Space |
| 拖拽时光标 | `ClipCursor` 把光标锁在原位 | **不锁**（macOS 没有等价的公开 API），光标跟手，窗口照常跟动 |
| 本地语音兜底 | Windows 语音（Yaoyao） | 系统 `say` 命令（Tingting 音色） |

其余功能（DeepSeek 聊天、语音合成、记忆、提醒、酒馆、角色卡、群聊）完全一致。

---

## 六、改 mac 打包配置要动哪些地方

| 文件 | 作用 |
|---|---|
| `electron-builder.yml` | `mac` / `dmg` 段：目标架构、ad-hoc 签名、麦克风用途说明 |
| `.github/workflows/build-mac.yml` | CI：macOS runner 构建 + 上传 + 建 Release |
| `package.json` | `dist:mac` / `pack:mac` |
| `tools/make-mac-icons.mjs` | 生成 `build/icon.png`（1024）与菜单栏 Template 图 |

**以后如果要签名**：在 `mac` 段把 `identity: '-'` 换成开发者 ID 名称，
配上 `hardenedRuntime: true` 和 entitlements，再把证书（.p12）放进 CI 的 Secrets。
代码这边不用动。
