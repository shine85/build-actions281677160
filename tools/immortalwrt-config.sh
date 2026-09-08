#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="${repo_root}/build/Immortalwrt"
backup_dir="${repo_root}/tmp/immortalwrt-original"

fail() {
  printf '配置错误: %s\n' "$*" >&2
  exit 1
}

read_config() {
  local config_line
  config_line="$(grep -m1 '^CONFIG_FILE=' "$1")" || fail "$1 缺少 CONFIG_FILE"
  printf '%s\n' "$config_line" | sed -E 's/^CONFIG_FILE=//; s/[[:space:]]*#.*$//; s/^"//; s/"[[:space:]]*$//; s/[[:space:]]+$//'
}

validate_config() {
  local config="$1"
  [[ "$config" =~ ^[A-Za-z0-9_-]+$ ]] || fail "无效配置名: ${config}"
  [[ -f "${config_dir}/seed/${config}" ]] || fail "缺少 seed/${config}"
  [[ -f "${config_dir}/diy-part.sh" ]] || fail '缺少 diy-part.sh'
  if [[ "$config" == *_250 ]]; then
    [[ -f "${config_dir}/diy-part-250.sh" ]] || fail "${config} 必须使用 diy-part-250.sh，文件不存在"
  fi
}

select_diy() {
  local config="$1"
  validate_config "$config"
  if [[ "$config" == *_250 ]]; then
    cp -f "${config_dir}/diy-part-250.sh" "${config_dir}/diy-part.sh"
    chmod +x "${config_dir}/diy-part.sh"
    printf '配置[%s]: 本次使用 diy-part-250.sh\n' "$config"
  else
    printf '配置[%s]: 本次使用 diy-part.sh\n' "$config"
  fi
}

case "${1:-}" in
  matrix)
    if [[ -n "${INPUT_CONFIG:-}" ]]; then
      configs=("$INPUT_CONFIG")
    else
      selected="$(read_config "${config_dir}/settings.ini")"
      read -r -a configs <<< "$selected"
    fi
    [[ ${#configs[@]} -gt 0 ]] || fail 'CONFIG_FILE 至少需要一个配置'
    declare -A seen=()
    matrix=''
    for config in "${configs[@]}"; do
      validate_config "$config"
      [[ -z "${seen[$config]:-}" ]] || fail "配置重复: ${config}"
      seen[$config]=1
      matrix+="\"${config}\","
    done
    printf 'configs=[%s]\n' "${matrix%,}" >> "${GITHUB_OUTPUT:?}"
    printf '本次编译配置: %s\n' "${configs[*]}"
    ;;
  prepare)
    validate_config "${PICK_CONFIG:?}"
    read_config "${config_dir}/settings.ini" > /dev/null
    mkdir -p "$backup_dir"
    cp -f "${config_dir}/diy-part.sh" "${backup_dir}/diy-part.sh"
    cp -f "${config_dir}/settings.ini" "${backup_dir}/settings.ini"
    sed -i "s/^CONFIG_FILE=.*/CONFIG_FILE=\"${PICK_CONFIG}\"/" "${config_dir}/settings.ini"
    select_diy "$PICK_CONFIG"
    ;;
  restore)
    [[ -d "${COMPILE_PATH:?}" ]] || fail "编译目录不存在: ${COMPILE_PATH}"
    cp -f "${backup_dir}/diy-part.sh" "${COMPILE_PATH}/diy-part.sh"
    cp -f "${backup_dir}/settings.ini" "${COMPILE_PATH}/settings.ini"
    chmod +x "${COMPILE_PATH}/diy-part.sh"
    printf '已还原长期配置与原版 diy-part.sh，本轮配置由 relevance/settings.ini 传递\n'
    ;;
  select)
    select_diy "$(read_config "${config_dir}/relevance/settings.ini")"
    ;;
  *)
    fail '用法: immortalwrt-config.sh matrix|prepare|restore|select'
    ;;
esac
