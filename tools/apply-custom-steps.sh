#!/usr/bin/env bash
#
# 同步上游(git merge upstream/main)之后,把本仓库的自定义 workflow 步骤重新套回去。
# 幂等:已经存在的步骤会跳过,可以反复运行。
#
#   bash tools/apply-custom-steps.sh          # 补回缺失的步骤
#   bash tools/apply-custom-steps.sh --check  # 只检查不改,有缺失则退出码1
#
# 只负责 workflow 里的「结构性插入」,不管以下内容(那些是纯配置,冲突时保留自己的即可):
#   build/Immortalwrt/diy-part.sh  diy-part-250.sh  seed/*  settings.ini
#
set -uo pipefail
cd "$(dirname "$0")/.."

CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

W1=".github/workflows/Immortalwrt.yml"
W2=".github/workflows/compile.yml"
W3=".github/workflows/Immortalwrt -250.yml"

ANCHOR_CHECKOUT="      uses: actions/checkout@v4"
ANCHOR_MISHI="      uses: 281677160/common@mishi"
ANCHOR_NEED="      uses: 281677160/common@need"

TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
CHANGED=0; MISSING=0; BROKEN=0

frag_pick_stage1(){ cat > "$TMPD/f" <<'FRAG'

    - name: 选择本次编译使用的diy脚本
      run: |
        cd "${GITHUB_WORKSPACE}/build/${FOLDER_NAME}"
        # 备份仓库原版diy-part.sh,mishi之后还原,确保仓库内diy-part.sh始终是6网段版本
        cp -f diy-part.sh /tmp/diy-part.sh.orig
        # 手动触发取输入框的机型,定时或其他触发取settings.ini的机型
        PICK_CONFIG="${{ github.event.inputs.CONFIG_FILE }}"
        if [[ -z "${PICK_CONFIG}" ]]; then
           PICK_CONFIG="$(grep -m1 '^CONFIG_FILE=' settings.ini | sed -E 's/^CONFIG_FILE=//; s/[[:space:]]*#.*$//; s/^"//; s/"[[:space:]]*$//')"
        fi
        if [[ "${PICK_CONFIG}" == *_250 ]] && [[ -f "diy-part-250.sh" ]]; then
           cp -f diy-part-250.sh diy-part.sh
           chmod +x diy-part.sh
           echo -e "\033[32m 机型[${PICK_CONFIG}]:本次使用 diy-part-250.sh (250网段) \033[0m"
        else
           echo -e "\033[32m 机型[${PICK_CONFIG}]:本次使用 diy-part.sh (6网段) \033[0m"
        fi
FRAG
}

frag_restore(){ cat > "$TMPD/f" <<'FRAG'

    - name: 还原diy-part.sh(避免250网段配置被固化回仓库)
      run: |
        if [[ -f "/tmp/diy-part.sh.orig" ]]; then
           cp -f /tmp/diy-part.sh.orig "${COMPILE_PATH}/diy-part.sh"
           chmod +x "${COMPILE_PATH}/diy-part.sh"
        fi
FRAG
}

frag_kucat_stage1(){ cat > "$TMPD/f" <<'FRAG'

    - name: 补回kucat配置插件到即将写入seed的配置
      run: |
        # 上游Diy_scripts按主题名执行 sed "/kucat/d",会连带删掉kucat-config两项,
        # 这里补回,保证@trigger推回仓库的seed始终带这两项
        for P in luci-app-kucat-config luci-i18n-kucat-config-zh-cn; do
           if grep -q "^CONFIG_PACKAGE_${P}=y$" "${CONFIG_TXT}"; then
              echo -e "\033[32m 已存在 CONFIG_PACKAGE_${P}=y \033[0m"
           else
              echo "CONFIG_PACKAGE_${P}=y" >> "${CONFIG_TXT}"
              echo -e "\033[32m 已补回 CONFIG_PACKAGE_${P}=y \033[0m"
           fi
        done
FRAG
}

frag_pick_stage2(){ cat > "$TMPD/f" <<'FRAG'

    - name: 选择本次编译使用的diy脚本
      run: |
        cd "${GITHUB_WORKSPACE}/build/${FOLDER_NAME}"
        # 机型取自阶段一固化的relevance/settings.ini,取不到则用默认的diy-part.sh
        PICK_CONFIG="$(grep -m1 '^CONFIG_FILE=' relevance/settings.ini | sed -E 's/^CONFIG_FILE=//; s/[[:space:]]*#.*$//; s/^"//; s/"[[:space:]]*$//')"
        if [[ "${PICK_CONFIG}" == *_250 ]] && [[ -f "diy-part-250.sh" ]]; then
           cp -f diy-part-250.sh diy-part.sh
           chmod +x diy-part.sh
           echo -e "\033[32m 机型[${PICK_CONFIG}]:本次使用 diy-part-250.sh (250网段) \033[0m"
        else
           echo -e "\033[32m 机型[${PICK_CONFIG}]:本次使用 diy-part.sh (6网段) \033[0m"
        fi
FRAG
}

frag_kucat_stage2(){ cat > "$TMPD/f" <<'FRAG'

    - name: 补回kucat配置插件并核验kucat必须存在
      run: |
        cd "${HOME_PATH}"
        # 上游Diy_scripts按主题名执行 sed "/kucat/d",会连带删掉kucat-config两项
        for P in luci-app-kucat-config luci-i18n-kucat-config-zh-cn; do
           sed -i "/^# CONFIG_PACKAGE_${P} is not set$/d" .config
           grep -q "^CONFIG_PACKAGE_${P}=y$" .config || echo "CONFIG_PACKAGE_${P}=y" >> .config
        done
        make defconfig > /dev/null 2>&1
        MISS=""
        for P in luci-theme-kucat luci-app-kucat-config luci-i18n-kucat-config-zh-cn; do
           if grep -q "^CONFIG_PACKAGE_${P}=y$" .config; then
              echo -e "\033[32m 已选中 CONFIG_PACKAGE_${P}=y \033[0m"
           else
              MISS="${MISS} ${P}"
           fi
        done
        if [[ -n "${MISS}" ]]; then
           echo -e "\033[31m kucat要求未满足,缺失:${MISS} \033[0m"
           exit 1
        fi
FRAG
}

# 在锚点行之后插入一个步骤;步骤名已存在则跳过
insert_step(){ # $1=yml $2=步骤名 $3=锚点 $4=生成片段的函数名
  local f="$1" name="$2" anchor="$3" mk="$4"
  if [[ ! -f "$f" ]]; then
    printf '  文件不存在!   %s\n' "$f"; BROKEN=$((BROKEN+1)); return
  fi
  if grep -qF "    - name: ${name}" "$f"; then
    printf '  已存在  %-46s %s\n' "$name" "${f##*/}"; return
  fi
  if [[ "$CHECK" == 1 ]]; then
    printf '  缺失!   %-46s %s\n' "$name" "${f##*/}"; MISSING=$((MISSING+1)); return
  fi
  if ! grep -qxF "$anchor" "$f"; then
    printf '  锚点没了! %-44s %s <- 上游可能改了结构,要手工处理\n' "$name" "${f##*/}"
    BROKEN=$((BROKEN+1)); return
  fi
  "$mk"
  awk -v ff="$TMPD/f" -v a="$anchor" \
    '{print} $0==a && !d {while((getline l < ff)>0) print l; d=1}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  printf '  已插入  %-46s %s\n' "$name" "${f##*/}"; CHANGED=$((CHANGED+1))
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
  awk -v o="$opt" '{print} $0=="          - '\''x86_64'\''" && !d {print o; d=1}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  printf '  已插入  %-46s %s\n' "机型下拉 x86_64_250" "${f##*/}"; CHANGED=$((CHANGED+1))
}

echo "== 阶段一 ${W1##*/}"
add_option     "$W1"
insert_step    "$W1" "选择本次编译使用的diy脚本"              "$ANCHOR_CHECKOUT" frag_pick_stage1
insert_step    "$W1" "还原diy-part.sh(避免250网段配置被固化回仓库)" "$ANCHOR_MISHI"    frag_restore
insert_step    "$W1" "补回kucat配置插件到即将写入seed的配置"   "$ANCHOR_NEED"     frag_kucat_stage1

echo "== 阶段一(250入口) ${W3##*/}"
insert_step    "$W3" "选择本次编译使用的diy脚本"              "$ANCHOR_CHECKOUT" frag_pick_stage1
insert_step    "$W3" "还原diy-part.sh(避免250网段配置被固化回仓库)" "$ANCHOR_MISHI"    frag_restore
insert_step    "$W3" "补回kucat配置插件到即将写入seed的配置"   "$ANCHOR_NEED"     frag_kucat_stage1

echo "== 阶段二 ${W2##*/}"
insert_step    "$W2" "选择本次编译使用的diy脚本"              "$ANCHOR_CHECKOUT" frag_pick_stage2
insert_step    "$W2" "补回kucat配置插件并核验kucat必须存在"    "$ANCHOR_NEED"     frag_kucat_stage2

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
  for f in "$W1" "$W2" "$W3"; do
    [[ -f "$f" ]] || continue
    if npx --yes js-yaml "$f" >/dev/null 2>&1; then printf '  通过  %s\n' "${f##*/}"
    else printf '  不通过! %s\n' "${f##*/}"; RC=1; fi
  done
  [[ "$RC" == 0 ]] || { echo "有文件语法不通过,先修好再提交"; exit 1; }
else
  echo "没找到 npx,跳过 YAML 校验;请自行确认三个 workflow 能被解析"
fi

[[ "$BROKEN" -eq 0 ]] || exit 1
echo "完成"
