#!/bin/bash
# Copyright (c) 2019-2020 P3TERX
# DIY扩展二合一了，在此处可以增加插件
# 自行拉取插件之前请SSH连接进入固件配置里面确认过没有你要的插件再单独拉取你需要的插件
# 不要一下就拉取别人一个插件包N多插件的，多了没用，增加编译错误，自己需要的才好

set -e

# =========================================================
# 0) 工具函数：把配置写进“最终会被合成”的配置源
#    你这套Actions最终 .config 通常由 CONFIG_TXT / MYCONFIG_FILE 合成覆盖
# =========================================================
append_cfg_file() {
  # $1: 文件路径
  # $2: 一行配置（例如 CONFIG_PACKAGE_xxx=y）
  local f="$1"
  local line="$2"
  [ -n "$f" ] || return 0
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  [ -f "$f" ] || touch "$f"
  grep -q "^${line}$" "$f" 2>/dev/null || echo "$line" >> "$f"
}

append_cfg() {
  local line="$1"
  # 1) 写入 CONFIG_TXT（/tmp/common/config.txt）
  if [ -n "${CONFIG_TXT:-}" ]; then
    append_cfg_file "$CONFIG_TXT" "$line"
  fi
  # 2) 写入 seed（operates/.../seed/x86_64）
  if [ -n "${MYCONFIG_FILE:-}" ]; then
    append_cfg_file "$MYCONFIG_FILE" "$line"
  fi
}

# =========================================================
# 1) 主题 & 插件：kucat + kucat-config（先clone）
# =========================================================
rm -rf package/luci-theme-kucat package/luci-app-kucat-config

git clone --depth 1 https://github.com/sirpdboy/luci-theme-kucat package/luci-theme-kucat
git clone --depth 1 https://github.com/sirpdboy/luci-app-kucat-config package/luci-app-kucat-config

# =========================================================
# 2) 24.10 兼容补丁：让 luci-app-kucat-config “可选/可编”
#    常见情况：旧LuCI依赖写法导致在24.10下不可见 -> defconfig会清洗
# =========================================================
KUCAT_MK="package/luci-app-kucat-config/Makefile"
if [ -f "$KUCAT_MK" ]; then
  echo ">>> Patch luci-app-kucat-config Makefile for ImmortalWrt 24.10 ..."

  # (A) 旧的 luci-lua-runtime 在 24.10 可能不存在/不匹配，替换为 luci-base
  sed -i 's/luci-lua-runtime/luci-base/g' "$KUCAT_MK" || true

  # (B) 移除常见旧 host build 依赖（24.10经常不再需要/名称不同）
  #     避免被判定“不可构建”进而不可选
  sed -i 's/luci-base\/host//g; s/csstidy\/host//g; s/luasrcdiet\/host//g' "$KUCAT_MK" || true
  sed -i 's/  \+/ /g' "$KUCAT_MK" || true

  # (C) 如果写了奇怪的分隔符，顺便清一下多余冒号后空格（不强制）
  sed -i 's/PKG_BUILD_DEPENDS:= */PKG_BUILD_DEPENDS:=/g' "$KUCAT_MK" || true
fi

# =========================================================
# 3) 强制选中 + 依赖：写入 CONFIG_TXT & seed，避免被覆盖/清洗
# =========================================================
append_cfg "CONFIG_PACKAGE_luci-theme-kucat=y"
append_cfg "CONFIG_PACKAGE_luci-app-kucat-config=y"

# 依赖（按你之前思路补齐）
append_cfg "CONFIG_PACKAGE_luci-compat=y"
append_cfg "CONFIG_PACKAGE_luci-lib-ipkg=y"
append_cfg "CONFIG_PACKAGE_curl=y"

# 可选：有的分支会有这个i18n包，有的没有；不强制，自己需要再打开
# append_cfg "CONFIG_PACKAGE_luci-i18n-kucat-config-zh-cn=y"

# =========================================================
# 4) 后台IP设置
# =========================================================
export Ipv4_ipaddr="192.168.6.2"            # 修改openwrt后台地址(填0为关闭)
export Netmask_netm="255.255.255.0"         # IPv4 子网掩码（默认：255.255.255.0）(填0为不作修改)
export Op_name="OP-Shine"                   # 修改主机名称(填0为不作修改)

# 内核和系统分区大小(不是每个机型都可用)
export Kernel_partition_size="0"
export Rootfs_partition_size="0"

# 默认主题设置
export Mandatory_theme="argon"
export Default_theme="kucat"

# 旁路由选项
export Gateway_Settings="192.168.6.1"
export DNS_Settings="223.5.5.5"
export Broadcast_Ipv4="0"
export Disable_DHCP="1"
export Disable_Bridge="1"
export Create_Ipv6_Lan="1"

# IPV6、IPV4 选择
export Enable_IPV6_function="0"
export Enable_IPV4_function="0"

# 替换OpenClash的源码(默认master分支)
export OpenClash_branch="0"

# 个性签名
export Customized_Information="༄Shine 🔸࿐ 编译于$(TZ=UTC-8 date "+%Y.%m.%d")"

# 更换固件内核
export Replace_Kernel="0"

# 设置免密码登录
export Password_free_login="1"

# 增加AdGuardHome插件和核心
export AdGuardHome_Core="0"

# 开启NTFS格式盘挂载
export Automatic_Mount_Settings="0"

# 去除网络共享(autosamba)
export Disable_autosamba="1"

# 其他
export Ttyd_account_free_login="1"
export Delete_unnecessary_items="0"
export Disable_53_redirection="0"
export Cancel_running="0"

# 晶晨CPU系列打包固件设置(不懂请看说明)
export amlogic_model="s905d"
export amlogic_kernel="6.1.120_6.12.15"
export auto_kernel="true"
export rootfs_size="512/2560"
export kernel_usage="stable"

# =========================================================
# 5) 修改插件名字
# =========================================================
grep -rl '"终端"' . | xargs -r sed -i 's?"终端"?"TTYD"?g'
grep -rl '"TTYD 终端"' . | xargs -r sed -i 's?"TTYD 终端"?"TTYD"?g'
grep -rl '"网络存储"' . | xargs -r sed -i 's?"网络存储"?"NAS"?g'
grep -rl '"实时流量监测"' . | xargs -r sed -i 's?"实时流量监测"?"流量"?g'
grep -rl '"KMS 服务器"' . | xargs -r sed -i 's?"KMS 服务器"?"KMS激活"?g'
grep -rl '"USB 打印服务器"' . | xargs -r sed -i 's?"USB 打印服务器"?"打印服务"?g'
grep -rl '"Web 管理"' . | xargs -r sed -i 's?"Web 管理"?"Web管理"?g'
grep -rl '"管理权"' . | xargs -r sed -i 's?"管理权"?"改密码"?g'
grep -rl '"带宽监控"' . | xargs -r sed -i 's?"带宽监控"?"监控"?g'

# =========================================================
# 6) 整理固件包时候删除不想要的文件
# =========================================================
cat >"$CLEAR_PATH" <<-EOF
packages
config.buildinfo
feeds.buildinfo
sha256sums
version.buildinfo
profiles.json
openwrt-x86-64-generic-kernel.bin
openwrt-x86-64-generic.manifest
openwrt-x86-64-generic-squashfs-rootfs.img.gz
EOF

# 在线更新时删除不想保留的文件
cat >>"$DELETE" <<-EOF
EOF

# =========================================================
# 7) 构建前强制校验：确保“真正写进最终配置源”
#    缺失就直接失败，避免你白跑一整轮
# =========================================================
echo ">>> Verify Kucat config lines in CONFIG_TXT/MYCONFIG_FILE ..."

if [ -n "${CONFIG_TXT:-}" ] && [ -f "$CONFIG_TXT" ]; then
  grep -q "^CONFIG_PACKAGE_luci-app-kucat-config=y$" "$CONFIG_TXT" || {
    echo
    echo "❌ ERROR: CONFIG_TXT 中没有 CONFIG_PACKAGE_luci-app-kucat-config=y"
    echo "❌ 说明：配置没有进入最终合成源（或被前面脚本覆盖）"
    echo
    exit 1
  }
fi

if [ -n "${MYCONFIG_FILE:-}" ] && [ -f "$MYCONFIG_FILE" ]; then
  grep -q "^CONFIG_PACKAGE_luci-app-kucat-config=y$" "$MYCONFIG_FILE" || {
    echo
    echo "❌ ERROR: seed(x86_64) 中没有 CONFIG_PACKAGE_luci-app-kucat-config=y"
    echo "❌ 说明：seed没有写进去，后续合成仍可能丢失"
    echo
    exit 1
  }
fi

echo "✅ OK: luci-app-kucat-config 已写入最终配置源（CONFIG_TXT/seed）"
