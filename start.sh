#!/usr/bin/env bash
# ===========================================================================
#  CAJ 阅读器 — macOS / Linux 一键启动
#  需要 Node.js 18+（仅用于起一个本地静态服务，不做任何转换运算）
# ===========================================================================
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  [错误] 没有找到 Node.js。"
  echo "  请先安装：https://nodejs.org/  （建议 LTS 版本）"
  echo
  exit 1
fi

exec node serve.js --port "${1:-8080}"
