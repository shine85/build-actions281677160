#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 定时和手动入口都从 mishi 接收这两个值；空值不能交给清理动作。
for name in KEEP_RELEASES KEEP_WORKFLOWS; do
  value="${!name-}"
  if [[ ! "$value" =~ ^(0|[1-9][0-9]*)$ ]]; then
    printf '配置错误: %s 必须是非负整数，当前值为 [%s]\n' "$name" "$value" >&2
    exit 1
  fi
done

common_dir="${LINSHI_COMMON:?缺少上游脚本目录}"
patch_file="$repo_root/tools/patches/immortalwrt-common.patch"

# 整份补丁先检查再应用，上游结构变化时明确失败，避免部分修复继续构建。
patch --dry-run --batch --forward --fuzz=0 --reject-file=- -p1 -d "$common_dir" -i "$patch_file"
patch --batch --forward --fuzz=0 --no-backup-if-mismatch --reject-file=- -p1 -d "$common_dir" -i "$patch_file"
printf '已修正在线更新配置标识与环境依赖脚本\n'
