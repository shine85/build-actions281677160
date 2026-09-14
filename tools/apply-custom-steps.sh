#!/usr/bin/env bash
#
# 同步上游(git merge upstream/main)之后,把本仓库的自定义 workflow 步骤重新套回去。
# 幂等:已经存在的步骤会跳过,可以反复运行。
#
#   bash tools/apply-custom-steps.sh          # 补回缺失的步骤
#   bash tools/apply-custom-steps.sh --check  # 只检查不改,有缺失则退出码1
#
# 维护 checkout 运行时引用及两个主 workflow 的结构,不管以下内容(那些是纯配置,冲突时保留自己的即可):
#   build/Immortalwrt/diy-part.sh  diy-part-250.sh  seed/*  settings.ini
#
set -uo pipefail
cd "$(dirname "$0")/.."

CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

W1=".github/workflows/Immortalwrt.yml"
W2=".github/workflows/compile.yml"
CHECKOUT_ACTION='actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1'
CHECKOUT_ANCHOR="      uses: $CHECKOUT_ACTION"
CHECKOUT_LEGACY="^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]+['\"]?actions/checkout@v4([.][0-9]+)*['\"]?([[:space:]]|$)"
ANCHOR_MISHI="      uses: ./.github/actions/immortalwrt-mishi"
MISHI_CONFIG='        config_file: ${{ matrix.config_file }}'
ANCHOR_NEED="      uses: 281677160/common@need"

TMPD=''
if [[ "$CHECK" == 0 ]]; then
  mkdir -p tmp
  TMPD="$(mktemp -d "$PWD/tmp/custom-steps.XXXXXX")" || exit 1
  trap 'rm -f "$TMPD/f" "$TMPD/workflow"; rmdir "$TMPD"' EXIT
fi
CHANGED=0; MISSING=0; BROKEN=0

frag_concurrency(){ cat > "$TMPD/f" <<'FRAG'

concurrency:
  group: immortalwrt-prepare-${{ github.ref }}
  cancel-in-progress: false
FRAG
}

frag_plan(){ cat > "$TMPD/f" <<'FRAG'
  plan:
    name: 规划本次编译配置
    runs-on: ubuntu-22.04
    outputs:
      configs: ${{ steps.configs.outputs.configs }}
    steps:
    - name: 读取配置
FRAG
  printf '%s\n' "$CHECKOUT_ANCHOR" >> "$TMPD/f"
  cat >> "$TMPD/f" <<'FRAG'
    - name: 生成配置矩阵
      id: configs
      env:
        INPUT_CONFIG: ${{ github.event.inputs.CONFIG_FILE }}
      run: bash tools/immortalwrt-config.sh matrix

FRAG
}

frag_needs(){ printf '    needs: plan\n' > "$TMPD/f"; }
frag_parallel(){ printf '      max-parallel: 1\n' > "$TMPD/f"; }
frag_matrix(){ cat > "$TMPD/f" <<'FRAG'
        config_file: ${{ fromJSON(needs.plan.outputs.configs) }}
FRAG
}

frag_checkout_stage1(){ cat > "$TMPD/f" <<'FRAG'
      with:
        ref: ${{ github.ref_name }}
FRAG
}

frag_checkout_stage2(){ cat > "$TMPD/f" <<'FRAG'
      with:
        ref: ${{ github.sha }}
FRAG
}

frag_pick_stage1(){ cat > "$TMPD/f" <<'FRAG'

    - name: 选择本次编译使用的diy脚本
      env:
        PICK_CONFIG: ${{ matrix.config_file }}
      run: bash tools/immortalwrt-config.sh prepare
FRAG
}

frag_restore(){ cat > "$TMPD/f" <<'FRAG'

    - name: 还原长期配置和diy脚本
      run: bash tools/immortalwrt-config.sh restore
FRAG
}

frag_prepare_common(){ cat > "$TMPD/f" <<'FRAG'

    - name: 应用上游编译修复
      run: bash tools/prepare-immortalwrt.sh
FRAG
}

frag_mishi_stage1(){ cat > "$TMPD/f" <<'FRAG'
      uses: ./.github/actions/immortalwrt-mishi
      with:
        config_file: ${{ matrix.config_file }}
FRAG
}

frag_mishi_stage2(){
  printf '%s\n' "$ANCHOR_MISHI" > "$TMPD/f"
}

frag_deploy_command(){ cat > "$TMPD/f" <<'FRAG'
        export TMP_DIR="${RUNNER_TEMP}/immortalwrt-dependencies"
        mkdir -p "$TMP_DIR"
        sudo --preserve-env=DEBIAN_FRONTEND,TMP_DIR bash -e -o pipefail "${LINSHI_COMMON}/custom/ubuntu.sh"
FRAG
}

frag_firmware_command(){
  printf '%s\n' '        bash -e "${COMMON_SH}" Diy_firmware' > "$TMPD/f"
}

frag_release_action(){
  printf '%s\n' '      uses: ./.github/actions/immortalwrt-release' > "$TMPD/f"
}

frag_release_description(){ cat > "$TMPD/f" <<'FRAG'

    - name: 生成发布标题和插件说明
      if: steps.compile.outcome == 'success' && env.UPDATE_FIRMWARE_ONLINE == 'true'
      uses: actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8
      with:
        script: |
          const release = require(process.env.GITHUB_WORKSPACE + '/tools/immortalwrt-release.cjs');
          const info = await release.describe();
          core.exportVariable('IMMORTALWRT_RELEASE_NAME', info.name);
          core.exportVariable('IMMORTALWRT_RELEASE_BODY', info.body);
FRAG
}

frag_runtime_command(){ cat > "$TMPD/f" <<'FRAG'
      run: |
        export IMMORTALWRT_RUNTIME_REPORT="$GITHUB_WORKSPACE/tmp/immortalwrt-runtime-verification.json"
        printf 'IMMORTALWRT_RUNTIME_REPORT=%s\n' "$IMMORTALWRT_RUNTIME_REPORT" >> "$GITHUB_ENV"
        node tools/immortalwrt-runtime.cjs
FRAG
}

frag_runtime_verification(){
  frag_runtime_command
  local run_block
  run_block="$(cat "$TMPD/f")"
  cat > "$TMPD/f" <<'FRAG'

    - name: 启动固件并验收网络和插件
      if: steps.compile.outcome == 'success' && env.TARGET_BOARD == 'x86'
FRAG
  printf '%s\n' "$run_block" >> "$TMPD/f"
}

frag_runtime_report(){ cat > "$TMPD/f" <<'FRAG'

    - name: 保存固件运行验收报告
      if: always() && steps.compile.outcome == 'success' && env.TARGET_BOARD == 'x86'
      uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
      with:
        name: firmware-runtime-${{ env.CONFIG_FILE }}-${{ env.LUCI_EDITION }}-attempt-${{ github.run_attempt }}
        path: ${{ env.IMMORTALWRT_RUNTIME_REPORT }}
        if-no-files-found: error
FRAG
}

frag_debug_firmware(){ cat > "$TMPD/f" <<'FRAG'

    - name: 保存失败固件诊断镜像
      if: failure() && steps.compile.outcome == 'success' && env.TARGET_BOARD == 'x86' && env.UPLOAD_FIRMWARE == 'true'
      uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
      with:
        name: firmware-debug-${{ env.CONFIG_FILE }}-${{ env.LUCI_EDITION }}-attempt-${{ github.run_attempt }}
        path: |
          ${{ env.FIRMWARE_PATH }}/*-squashfs-combined*.img.gz
          ${{ env.FIRMWARE_PATH }}/*.manifest
        if-no-files-found: error
        retention-days: 3
FRAG
}

frag_compile_timestamp(){ cat > "$TMPD/f" <<'FRAG'
        make -j$(nproc) || make -j1 V=s
        printf 'IMMORTALWRT_COMPILED_AT=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" >> "$GITHUB_ENV"
FRAG
}

frag_kucat_stage1(){ cat > "$TMPD/f" <<'FRAG'

    - name: 补回kucat并核验所选插件
      run: node tools/immortalwrt-plugins.cjs --write-seed
FRAG
}

frag_pick_stage2(){ cat > "$TMPD/f" <<'FRAG'

    - name: 选择本次编译使用的diy脚本
      run: bash tools/immortalwrt-config.sh select
FRAG
}

frag_kucat_stage2(){ cat > "$TMPD/f" <<'FRAG'

    - name: 补回kucat并核验所选插件
      run: node tools/immortalwrt-plugins.cjs
FRAG
}

insert_block(){
  local file="$1" marker="$2" anchor="$3" generator="$4" scope="${5:-build}"
  if [[ ! -f "$file" ]]; then
    printf '  文件不存在!   %s\n' "$file"; BROKEN=$((BROKEN+1)); return
  fi
  if grep -qxF "$marker" "$file"; then
    printf '  已存在  %s %s\n' "$marker" "${file##*/}"; return
  fi
  if [[ "$CHECK" == 1 ]]; then
    printf '  缺失!   %s %s\n' "$marker" "${file##*/}"; MISSING=$((MISSING+1)); return
  fi
  if ! grep -qxF "$anchor" "$file"; then
    printf '  锚点没了! %s %s <- 上游可能改了结构,要手工处理\n' "$marker" "${file##*/}"
    BROKEN=$((BROKEN+1)); return
  fi
  "$generator"
  if ! awk -v fragment="$TMPD/f" -v anchor="$anchor" -v scope="$scope" '
    $0=="  build:" {in_build=1}
    {print}
    $0==anchor && !inserted && (scope=="all" || in_build) {
      while ((getline fragment_line < fragment)>0) print fragment_line
      inserted=1
    }
    END {if (!inserted) exit 1}
  ' "$file" > "$TMPD/workflow"; then
    printf '  锚点作用域不匹配! %s %s\n' "$marker" "${file##*/}"
    BROKEN=$((BROKEN+1)); return
  fi
  cat "$TMPD/workflow" > "$file" || exit 1
  printf '  已插入  %s %s\n' "$marker" "${file##*/}"; CHANGED=$((CHANGED+1))
}

insert_step(){
  insert_block "$1" "    - name: $2" "$3" "$4"
}

ensure_plugin_step(){
  local file="$1" old="    - name: $2" expected="$3" generator="$4"
  local marker="    - name: 补回kucat并核验所选插件"
  if ! grep -qxF -e "$old" -e "$marker" "$file"; then
    insert_step "$file" "补回kucat并核验所选插件" "$ANCHOR_NEED" "$generator"
    return
  fi
  if awk -v old="$old" -v marker="$marker" -v expected="$expected" '
    /^    - name:/ {active=($0==old || $0==marker); if (active) count++}
    active && NF {if ($0==expected) command++; else if ($0!=marker) invalid=1}
    END {exit !(count==1 && command==1 && !invalid)}
  ' "$file"; then
    printf '  已核验全部所选插件  %s\n' "${file##*/}"; return
  fi
  if [[ "$CHECK" == 1 ]]; then
    printf '  缺失! 完整插件校验 %s\n' "${file##*/}"; MISSING=$((MISSING+1)); return
  fi
  "$generator"
  awk -v old="$old" -v marker="$marker" -v fragment="$TMPD/f" '
    $0==old || $0==marker {
      if (!inserted) {while ((getline line < fragment)>0) print line; inserted=1}
      skip=1; next
    }
    /^    - name:/ {skip=0}
    !skip {print}
  ' "$file" > "$TMPD/workflow"
  cat "$TMPD/workflow" > "$file" || exit 1
  printf '  已升级完整插件校验  %s\n' "${file##*/}"; CHANGED=$((CHANGED+1))
}

ensure_strict_step(){
  local file="$1" name="$2" marker="    - name: $2"
  if ! grep -qxF "$marker" "$file"; then
    printf '  步骤不存在! %s %s\n' "$name" "${file##*/}"; BROKEN=$((BROKEN+1)); return
  fi
  if ! awk -v marker="$marker" '
    /^    - name:/ {active=($0==marker)}
    active && /^      continue-on-error:/ {found=1}
    END {exit !found}
  ' "$file"; then
    printf '  已严格传播失败  %s\n' "$name"; return
  fi
  if [[ "$CHECK" == 1 ]]; then
    printf '  仍忽略失败! %s\n' "$name"; MISSING=$((MISSING+1)); return
  fi
  awk -v marker="$marker" '
    /^    - name:/ {active=($0==marker)}
    active && /^      continue-on-error:/ {next}
    {print}
  ' "$file" > "$TMPD/workflow"
  cat "$TMPD/workflow" > "$file" || exit 1
  printf '  已启用失败传播  %s\n' "$name"; CHANGED=$((CHANGED+1))
}

replace_command(){
  local file="$1" old="$2" expected="$3" generator="$4" label="$5"
  if grep -qxF "$expected" "$file"; then
    printf '  已使用修复后的%s\n' "$label"; return
  fi
  if [[ "$CHECK" == 1 ]]; then
    printf '  缺失! 修复后的%s\n' "$label"; MISSING=$((MISSING+1)); return
  fi
  if ! grep -qxF "$old" "$file"; then
    printf '  锚点没了! %s\n' "$label"; BROKEN=$((BROKEN+1)); return
  fi
  "$generator"
  awk -v old="$old" -v fragment="$TMPD/f" '
    $0==old {while ((getline line < fragment)>0) print line; next}
    {print}
  ' "$file" > "$TMPD/workflow"
  cat "$TMPD/workflow" > "$file" || exit 1
  printf '  已替换%s\n' "$label"; CHANGED=$((CHANGED+1))
}

ensure_schedule_condition(){
  local expected="    if: \${{ github.event_name == 'schedule' || github.event.repository.owner.id == github.event.sender.id }}"
  if grep -qxF "$expected" "$W1"; then
    echo '  已存在  定时触发条件'; return
  fi
  if [[ "$CHECK" == 1 ]]; then
    echo '  缺失!   定时触发条件'; MISSING=$((MISSING+1)); return
  fi
  if ! grep -q '^    if: .*github.event.repository.owner.id' "$W1"; then
    echo '  锚点没了! 定时触发条件'; BROKEN=$((BROKEN+1)); return
  fi
  awk -v expected="$expected" '/^    if: .*github.event.repository.owner.id/ {print expected; next} {print}' "$W1" > "$TMPD/workflow"
  cat "$TMPD/workflow" > "$W1" || exit 1
  echo '  已更新  定时触发条件'; CHANGED=$((CHANGED+1))
}

# 给阶段一入口的机型下拉补上 x86_64_250
add_option(){ # $1=yml
  local f="$1" opt="          - 'x86_64_250'"
  [[ -f "$f" ]] || return
  if grep -qxF "$opt" "$f"; then printf '  已存在  %-46s %s\n' "机型下拉 x86_64_250" "${f##*/}"; return; fi
  if [[ "$CHECK" == 1 ]]; then printf '  缺失!   %-46s %s\n' "机型下拉 x86_64_250" "${f##*/}"; MISSING=$((MISSING+1)); return; fi
  if ! grep -qxF "          - 'x86_64'" "$f"; then
    printf '  锚点没了! %-44s %s\n' "机型下拉 x86_64_250" "${f##*/}"; BROKEN=$((BROKEN+1)); return
  fi
  awk -v o="$opt" '{print} $0=="          - '\''x86_64'\''" && !d {print o; d=1}' "$f" > "$TMPD/workflow"
  cat "$TMPD/workflow" > "$f" || exit 1
  printf '  已插入  %-46s %s\n' "机型下拉 x86_64_250" "${f##*/}"; CHANGED=$((CHANGED+1))
}

upgrade_checkout(){
  local file="$1" status=0
  grep -qE "$CHECKOUT_LEGACY" "$file" || status=$?
  [[ "$status" == 1 ]] && return 0
  [[ "$status" == 0 ]] || exit "$status"
  if [[ "$CHECK" == 1 ]]; then
    printf '  旧 checkout 运行时! %s\n' "$file"; MISSING=$((MISSING+1)); return
  fi
  awk -v legacy="$CHECKOUT_LEGACY" -v checkout="$CHECKOUT_ACTION" '
    $0 ~ legacy {sub(/["\047]?actions\/checkout@v4([.][0-9]+)*["\047]?/, checkout)}
    {print}
  ' "$file" > "$TMPD/workflow" || exit 1
  cat "$TMPD/workflow" > "$file" || exit 1
  printf '  已升级 checkout 至 Node.js 24 版本  %s\n' "$file"; CHANGED=$((CHANGED+1))
}

echo "== checkout 运行时"
for workflow in .github/workflows/*.yml .github/workflows/*.yaml; do
  [[ -f "$workflow" ]] || continue
  upgrade_checkout "$workflow"
done

echo "== 阶段一 ${W1##*/}"
replace_command "$W1" '      uses: 281677160/common@mishi' "$ANCHOR_MISHI" frag_mishi_stage1 "矩阵准备动作"
if ! grep -qxF "$MISHI_CONFIG" "$W1"; then
  echo '  缺失! mishi 矩阵输入'; BROKEN=$((BROKEN+1))
fi
insert_block "$W1" 'concurrency:' '  TZ: Asia/Shanghai' frag_concurrency all
insert_block "$W1" '  plan:' 'jobs:' frag_plan all
insert_block "$W1" '    needs: plan' '  build:' frag_needs
insert_block "$W1" '      max-parallel: 1' '      fail-fast: false' frag_parallel
insert_block "$W1" '        config_file: ${{ fromJSON(needs.plan.outputs.configs) }}' '        target: [Immortalwrt]' frag_matrix
insert_block "$W1" '        ref: ${{ github.ref_name }}' "$CHECKOUT_ANCHOR" frag_checkout_stage1
ensure_schedule_condition
add_option     "$W1"
insert_step    "$W1" "选择本次编译使用的diy脚本"              '        ref: ${{ github.ref_name }}' frag_pick_stage1
insert_step    "$W1" "还原长期配置和diy脚本"                   "$MISHI_CONFIG"    frag_restore
insert_step    "$W1" "应用上游编译修复" '      run: bash tools/immortalwrt-config.sh restore' frag_prepare_common
ensure_plugin_step "$W1" "补回kucat配置插件到即将写入seed的配置" '      run: node tools/immortalwrt-plugins.cjs --write-seed' frag_kucat_stage1
ensure_strict_step "$W1" "清理releases和workflows"

echo "== 阶段二 ${W2##*/}"
replace_command "$W2" '      uses: 281677160/common@mishi' "$ANCHOR_MISHI" frag_mishi_stage2 "准备动作"
insert_block "$W2" '        ref: ${{ github.sha }}' "$CHECKOUT_ANCHOR" frag_checkout_stage2
insert_step    "$W2" "选择本次编译使用的diy脚本"              '        ref: ${{ github.sha }}' frag_pick_stage2
insert_step    "$W2" "应用上游编译修复" "$ANCHOR_MISHI" frag_prepare_common
ensure_plugin_step "$W2" "补回kucat配置插件并核验kucat必须存在" '      run: node tools/immortalwrt-plugins.cjs' frag_kucat_stage2
replace_command "$W2" \
  "        sudo bash -c 'bash <(curl -fsSL https://github.com/281677160/common/raw/main/custom/ubuntu.sh)'" \
  '        sudo --preserve-env=DEBIAN_FRONTEND,TMP_DIR bash -e -o pipefail "${LINSHI_COMMON}/custom/ubuntu.sh"' frag_deploy_command "部署脚本调用"
replace_command "$W2" \
  '        bash ${{ env.COMMON_SH }} Diy_firmware' \
  '        bash -e "${COMMON_SH}" Diy_firmware' frag_firmware_command "固件整理调用"
replace_command "$W2" \
  '      uses: 281677160/common@cloud' \
  '      uses: ./.github/actions/immortalwrt-release' frag_release_action "在线发布动作"
insert_step "$W2" "生成发布标题和插件说明" '      uses: 281677160/common@aarch' frag_release_description
insert_step "$W2" "启动固件并验收网络和插件" '      uses: 281677160/common@aarch' frag_runtime_verification
replace_command "$W2" '      run: node tools/immortalwrt-runtime.cjs' \
  '        export IMMORTALWRT_RUNTIME_REPORT="$GITHUB_WORKSPACE/tmp/immortalwrt-runtime-verification.json"' frag_runtime_command "独立运行验收报告路径"
insert_step "$W2" "保存固件运行验收报告" '        node tools/immortalwrt-runtime.cjs' frag_runtime_report
insert_step "$W2" "保存失败固件诊断镜像" '        if-no-files-found: error' frag_debug_firmware
replace_command "$W2" '        make -j$(nproc) || make -j1 V=s' \
  "        printf 'IMMORTALWRT_COMPILED_AT=%s\\n' \"\$(date -u +'%Y-%m-%dT%H:%M:%SZ')\" >> \"\$GITHUB_ENV\"" frag_compile_timestamp "编译完成时间记录"
ensure_strict_step "$W2" "启动固件并验收网络和插件"
ensure_strict_step "$W2" "保存固件运行验收报告"
ensure_strict_step "$W2" "保存失败固件诊断镜像"
ensure_strict_step "$W2" "生成发布标题和插件说明"
ensure_strict_step "$W2" "整理固件文件夹(需配合diy-part.sh设定使用)"
ensure_strict_step "$W2" "发送[在线更新固件]至云端"

for required in tools/immortalwrt-config.sh tools/prepare-immortalwrt.sh tools/patches/immortalwrt-common.patch build/Immortalwrt/patches/001-kconfig-reciprocal-conflicts.patch tools/immortalwrt-release.cjs tools/immortalwrt-network.cjs tools/immortalwrt-lan-defaults.sh tools/immortalwrt-plugins.cjs tools/immortalwrt-runtime.cjs tools/immortalwrt-runtime-probe.sh tools/immortalwrt-verification.cjs .github/actions/immortalwrt-release/action.yml .github/actions/immortalwrt-mishi/action.yml; do
  if [[ ! -f "$required" ]]; then
    printf '  文件不存在! %s\n' "$required"; BROKEN=$((BROKEN+1))
  fi
done

echo
if [[ "$CHECK" == 1 ]]; then
  echo "检查结果: 缺失 ${MISSING} 项, 结构异常 ${BROKEN} 项"
  [[ $((MISSING+BROKEN)) -eq 0 ]] && { echo "全部到位"; exit 0; } || exit 1
fi

echo "本次插入 ${CHANGED} 项, 结构异常 ${BROKEN} 项"

# 语法校验(没有 node/npx 就跳过并提示)
if command -v npx >/dev/null 2>&1; then
  echo "== YAML 语法校验"
  RC=0
  for f in "$W1" "$W2"; do
    [[ -f "$f" ]] || continue
    if npx --yes js-yaml "$f" >/dev/null; then printf '  通过  %s\n' "${f##*/}"
    else printf '  不通过! %s\n' "${f##*/}"; RC=1; fi
  done
  [[ "$RC" == 0 ]] || { echo "有文件语法不通过,先修好再提交"; exit 1; }
else
  echo "没找到 npx,跳过 YAML 校验;请自行确认两个 workflow 能被解析"
fi

[[ "$BROKEN" -eq 0 ]] || exit 1
echo "完成"
