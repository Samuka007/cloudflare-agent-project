#!/usr/bin/env bash
# #337 c2-thread-list 间歇红——本地高压复跑脚本（CI 等价场景）。
#
# CI 等价性：ci.yml verify job 的红面就是 apps/server-worker 的 vitest run
# （单一 worker 上下文、isolate:false——42 个测试文件共享一份 D1）。间歇红
# 的机制是共享库在 c2 运行时累积 ~73 条可见线程、读面 LIMIT-50 窗口按随机
# id 排序（修复前），任何一轮全量套件都可能触发；因此高压复跑 = 循环跑
# 同一套件直至轮数达标或首红退出。
#
# 用法：
#   nix run .#verify-c2-list-window                     # 默认 20 轮
#   nix run .#verify-c2-list-window -- --rounds 50      # 本地并行 50 轮零红
#   ROUNDS=50 ./scripts/verify-c2-list-window.sh        # 直接执行亦可
#
# 输出：每轮日志写入 .c2-verify-logs/round-NN.log（gitignored），退出码
# 0 = 全绿，1 = 首红（日志保留现场）。
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

ROUNDS="${ROUNDS:-20}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rounds)
      ROUNDS="${2:?--rounds needs a value}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

LOG_DIR="$REPO_ROOT/.c2-verify-logs"
mkdir -p "$LOG_DIR"

if [[ ! -d "$REPO_ROOT/apps/server-worker/node_modules" ]]; then
  echo "ERROR: workspace deps missing — run 'nix develop -c pnpm install --frozen-lockfile' first" >&2
  exit 2
fi

echo "verify-c2-list-window: $ROUNDS rounds of apps/server-worker vitest run (CI-equivalent scenario)"
for round in $(seq 1 "$ROUNDS"); do
  round_padded="$(printf '%02d' "$round")"
  log="$LOG_DIR/round-$round_padded.log"
  echo "--- round $round_padded/$ROUNDS → $log"
  if pnpm --dir "$REPO_ROOT/apps/server-worker" exec vitest run >"$log" 2>&1; then
    summary="$(grep -E 'Test Files' "$log" | tail -n 1 || true)"
    echo "    PASS $summary"
  else
    echo "    FAIL — first red at round $round_padded; full log: $log" >&2
    grep -E 'FAIL|AssertionError|Test Files' "$log" >&2 || true
    exit 1
  fi
done

echo "verify-c2-list-window: $ROUNDS rounds, zero red"
