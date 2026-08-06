#!/usr/bin/env bash
set -euo pipefail

GH_BIN="/tmp/gh-cli/bin/gh"

if [ ! -x "$GH_BIN" ]; then
  echo "找不到 $GH_BIN，请先重新下载 gh 二进制。" >&2
  exit 1
fi

# 1. 复制到 ~/bin 并加入 PATH
mkdir -p "$HOME/bin"
cp "$GH_BIN" "$HOME/bin/gh"
chmod +x "$HOME/bin/gh"

if ! grep -q 'HOME/bin' "$HOME/.zshrc" 2>/dev/null; then
  printf '\n# GitHub CLI (gh)\nexport PATH="$HOME/bin:$PATH"\n' >> "$HOME/.zshrc"
fi

# 2. 设置 git 提交身份（已有则跳过）
CURRENT_NAME="$(git config --global user.name || true)"
CURRENT_EMAIL="$(git config --global user.email || true)"

if [ -z "$CURRENT_NAME" ]; then
  read -r -p "请输入 GitHub 用户名: " GH_USER
  git config --global user.name "$GH_USER"
fi

if [ -z "$CURRENT_EMAIL" ]; then
  read -r -p "请输入 GitHub 账号绑定的邮箱: " GH_EMAIL
  git config --global user.email "$GH_EMAIL"
fi

echo "----------------------------------------"
"$HOME/bin/gh" --version
echo "安装完成。接下来请运行："
echo "  source ~/.zshrc"
echo "  gh auth login        # 选 GitHub.com → HTTPS → 浏览器登录"
echo "  gh auth setup-git    # 让 git 使用 gh 的凭据"
