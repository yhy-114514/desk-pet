#!/usr/bin/env bash
# 把 desk_pet 发布到 GitHub，并（可选）打 tag 触发 macOS 构建。
#
# 为什么不能直接 `git push`：
#   本地 git 根目录是 D:/AI_Working，desk_pet 只是其中一个子目录，同级还有
#   finance_cli / claude_start。直接推会把那些项目一起公开。
#
# 为什么不带提交历史：
#   素材目录里 `atlas` 一个就有 266MB，历史里还躺着 1.4G 的制作中间产物，
#   整个仓库 .git 已经 2G。GitHub 收这个没意义（CI 只需要最新一份能构建的代码），
#   所以这里导出**当前提交的一份快照**推到 GitHub，云端从零开始。
#   **你本地的提交历史一条不会少**，只是不往上传。
#
# 用法（在 Git Bash 里跑）：
#   bash tools/publish-github.sh https://github.com/你的用户名/desk-pet.git
#   bash tools/publish-github.sh https://github.com/你的用户名/desk-pet.git 0.1.0
#
# 第二个参数是版本号：给了就打 v<版本号> 的 tag 推上去，
# GitHub Actions 会开始构建 dmg 并生成 Release。
set -e

REPO_URL="${1:-}"
VERSION="${2:-}"

if [ -z "$REPO_URL" ]; then
  echo "用法：bash tools/publish-github.sh <仓库地址> [版本号]"
  echo "例：  bash tools/publish-github.sh https://github.com/yourname/desk-pet.git 0.1.0"
  exit 1
fi

ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
PREFIX="$(basename "$(cd "$(dirname "$0")/.." && pwd)")"
cd "$ROOT"

# 推出去的只是**已提交**的内容，没提交的改动不会上去——先挡住，免得推了旧代码还以为推了新的
if [ -n "$(git status --porcelain -- "$PREFIX")" ]; then
  echo "!! 有没提交的改动，推上去的会是旧代码。"
  echo "   先提交（git add / git commit），再跑这个脚本。"
  echo
  git status --short -- "$PREFIX" | head -20
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> 导出 $PREFIX 的当前快照（不含提交历史）"
# git archive 只导出版本控制里的文件：.gitignore 排除掉的中间产物、未跟踪的
# piupiu/ 之类都不会进来，正是我们要的
git archive --format=tar "HEAD:$PREFIX" | tar -x -C "$TMP"
SIZE="$(du -sh "$TMP" | cut -f1)"

cd "$TMP"
git init -q -b main
git add -A
git -c user.name="$(git -C "$ROOT" config user.name)" \
    -c user.email="$(git -C "$ROOT" config user.email)" \
    commit -q -m "chore: 同步 desk_pet 源码快照 (${VERSION:-dev})"

COUNT="$(git ls-files | wc -l | tr -d ' ')"
echo "    快照：$COUNT 个文件 / $SIZE"

echo "==> 推送到 $REPO_URL"
# 每次都是全新历史，必须 --force（第一次推空仓库时加了也无害）
git remote add origin "$REPO_URL"
git push --force origin main

if [ -n "$VERSION" ]; then
  echo "==> 打 tag v$VERSION"
  git tag -f "v$VERSION"
  git push --force origin "refs/tags/v$VERSION"
  echo
  echo "完成。GitHub Actions 正在构建 macOS 安装包（约 10 分钟），进度看："
  echo "  ${REPO_URL%.git}/actions"
  echo "构建完成后安装包会出现在："
  echo "  ${REPO_URL%.git}/releases"
else
  echo
  echo "完成。要出 macOS 安装包，带上版本号再跑一次，例如："
  echo "  bash tools/publish-github.sh $REPO_URL 0.1.0"
fi
