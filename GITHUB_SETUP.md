# 怎么把项目推到 GitHub（第一次做，照着抄就行）

推上去之后，每次发版 GitHub 会免费送一台 Mac 帮你打 dmg —— 这是出 macOS
安装包的**唯一**办法（Windows 上打不了）。

---

## 第 0 步：先搞清楚一件事

你的代码放在 `D:/AI_Working`，里面除了 `desk_pet` 还有 `finance_cli`、`claude_start`。
直接推会把那些项目一起公开。

所以下面的脚本只把 `desk_pet` 这一个目录**导出成一份快照**推上去：

- 仓库里看不到别的项目。
- **不带提交历史**。素材图集就有 266MB，历史里还有 1.4G 的制作中间产物
  （`p1-cut` / `p1-*` / `sprites`，构建用不到），整个 `.git` 已经 2GB。
  GitHub 上只存最新的一份能构建的代码，约 272MB。
- **你本地的提交历史一条都不会少**，只是不往上传。

这些已经写成脚本了，你不用记。

---

## 第 1 步：注册 GitHub（已有账号就跳过）

打开 <https://github.com/signup>，填邮箱、密码、用户名，验证邮箱。
用户名会出现在仓库地址里，起个英文的（比如 `bluewhale`）。

---

## 第 2 步：新建一个空仓库

1. 登录后点右上角 `+` → **New repository**
2. 填写：
   - **Repository name**：`desk-pet`
   - **Description**：随便写，比如 `蓝色大肥鱼桌宠`
   - 选 **Public**（公开）
     > **必须是 Public**。私有仓库的安装包下载链接需要登录才能打开，
     > 你的 Mac 用户拿不到。公开仓库的 Release 谁都能下载。
     > GitHub 只公开代码，你本地的 API Key、聊天记录、角色卡都在
     > `%APPDATA%` 里，不在这个仓库里，不会上去。
   - **不要**勾选 "Add a README file"、".gitignore"、"license"（保持空仓库）
3. 点 **Create repository**
4. 创建完页面会显示一个仓库地址，长这样：
   `https://github.com/你的用户名/desk-pet.git`
   **把这个地址复制下来**，下一步要用。

---

## 第 3 步：推代码上去（一条命令）

打开 **Git Bash**（在开始菜单搜 Git Bash），执行：

```bash
cd /d/AI_Working/desk_pet
bash tools/publish-github.sh https://github.com/你的用户名/desk-pet.git
```

（把地址换成第 2 步复制的那条）

**第一次运行会弹一个登录窗口**（Git Credential Manager）。
选 "Sign in with your browser"，浏览器里点一下授权，之后就不用再登录了。

跑完看到 `完成。` 就成功了。刷新 GitHub 页面，代码已经在了。

> **有没提交的改动时脚本会停下**，先把改过的文件提交掉再跑 —— 否则推上去的是旧代码，
> 你还以为推的是新的。（提交这件事你平时怎么做就怎么做，或者让 Claude 帮你提交。）

---

## 第 4 步：打 tag（触发 Mac 构建）

**tag 就是一个贴在某个提交上的标签**，GitHub 看到 `v0.1.0` 这种标签就知道
「这是一个正式版本，该出安装包了」。

还是在 Git Bash 里（同一个目录）：

```bash
cd /d/AI_Working/desk_pet
bash tools/publish-github.sh https://github.com/你的用户名/desk-pet.git 0.1.0
```

最后那个 `0.1.0` 就是版本号，脚本会自己打上 `v0.1.0` 这个 tag 推上去。

> 其实第 3 步和第 4 步可以直接合并成这一条命令——不用跑两遍。

---

## 第 5 步：等构建，拿安装包

1. 打开 `https://github.com/你的用户名/desk-pet/actions`
2. 会看到一个叫 **build-mac** 的任务在转圈（黄色），点进去能看实时日志
3. 大约 **10 分钟**后变成绿色 ✓
4. 打开 `https://github.com/你的用户名/desk-pet/releases`
5. 最新那条 Release 下面有两个文件：
   - `desk-pet-0.1.0-mac-arm64.dmg` —— Apple 芯片（M1/M2/M3/M4）
   - `desk-pet-0.1.0-mac-x64.dmg` —— Intel 芯片

**把这两个链接发给你的 Mac 用户就行。**

---

## 以后每次更新怎么发版

改完代码，先照常提交（在你习惯的地方），然后跑一条命令：

```bash
cd /d/AI_Working/desk_pet
bash tools/publish-github.sh https://github.com/你的用户名/desk-pet.git 0.1.1
```

版本号往上加。GitHub 会自动覆盖构建、生成新 Release。

> 版本号要和 `package.json` 里的 `version` 一致，否则安装包文件名和程序里显示的
> 版本对不上（脚本不会帮你改，需要手动改 `package.json` 第 3 行）。

---

## 想不推代码、只重新构建一次

打开 `https://github.com/你的用户名/desk-pet/actions` → 左边点 **build-mac** →
右边 **Run workflow** → 绿色按钮。这次不会生成 Release，产物在页面底部的
**Artifacts** 里下载（需要登录 GitHub）。

---

## 常见问题

**Q：构建失败了，红叉。**
点进去看哪一步红。最常见的是 `npm test` 挂了 —— 先把本地 `npx vitest run`
跑绿再推。日志全是英文，看不懂就把红色的那几行发给我。

**Q：Mac 用户说「打不开，已损坏」。**
不是文件坏了，是没签名。让用户**右键（或按住 Control 点）图标 →「打开」**，
弹窗里再点一次「打开」，之后就能正常双击。完整说明在 `MAC_RELEASE.md` 第三节。

**Q：能不能不公开代码？**
可以建私有仓库，但私有仓库的安装包下载需要登录，Mac 用户拿不到。
折中办法是私有仓库 + 把 dmg 再传到网盘分享。这个以后再说。

**Q：会花多少钱？**
公开仓库的 GitHub Actions **完全免费**，不限分钟数。
私有仓库每月有 2000 分钟免费额度，而 macOS 构建按 **10 倍**扣时 ——
一次构建约 15 分钟，折合 150 分钟，一个月能跑十几次。
