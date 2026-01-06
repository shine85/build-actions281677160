#!/bin/bash
# Copyright (c) 2019-2020 P3TERX <https://p3terx.com>
# DIY扩展二合一了，在此处可以增加插件
# 自行拉取插件之前请SSH连接进入固件配置里面确认过没有你要的插件再单独拉取你需要的插件
# 不要一下就拉取别人一个插件包N多插件的，多了没用，增加编译错误，自己需要的才好

set -e

#=========================================================
# 1) 拉取主题/插件源码
#=========================================================
#主题
git clone --depth 1 https://github.com/sirpdboy/luci-theme-kucat package/luci-theme-kucat
git clone --depth 1 https://github.com/sirpdboy/luci-app-kucat-config package/luci-app-kucat-config

#=========================================================
# 2) ✅ 关键修复（必须）：把“真正生效的选包动作”放到 feeds 安装之后
#    你的日志里 shows：defconfig 发生在 feeds 之前 -> 会把依赖不满足的包清洗掉
#    所以这里把修复逻辑注入到 $DIY_PT2_SH（后置阶段）去执行
#=========================================================
inject_post_fix() {
  # DIY_PT2_SH 由工作流环境提供（/tmp/common/Immortalwrt/diy2-part.sh）
  [ -n "$DIY_PT2_SH" ] || return 0

  # 避免重复注入
  if [ -f "$DIY_PT2_SH" ] && grep -q "KUCAT_POSTFIX_BEGIN" "$DIY_PT2_SH"; then
    echo ">>> Kucat postfix already injected into: $DIY_PT2_SH"
    return 0
  fi

  mkdir -p "$(dirname "$DIY_PT2_SH")"
  [ -f "$DIY_PT2_SH" ] || touch "$DIY_PT2_SH"

  cat >> "$DIY_PT2_SH" <<'EOF'
#==================== KUCAT_POSTFIX_BEGIN ====================
# 说明：
# feeds 安装完成后再强制写入 .config 并 make defconfig，
# 防止 luci-app-kucat-config 因依赖未就绪而被前置 defconfig 清洗。

set -e

echo ">>> [KUCAT] Post-fix: force select luci-app-kucat-config AFTER feeds"

# 必须在 OpenWrt 根目录执行
[ -f "./rules.mk" ] || { echo "❌ [KUCAT] Not in OpenWrt root (rules.mk not found)"; exit 1; }
[ -f ".config" ] || touch .config

ensure_cfg() {
  local k="$1"
  # 先删除可能存在的 “# ... is not set”
  sed -i "\|^# ${k} is not set$|d" .config
  # 再删除可能存在的 k=...（防止重复/冲突）
  sed -i "\|^${k}=.*$|d" .config
  # 写入 y
  echo "${k}=y" >> .config
}

# 强制选中（含常见依赖）
ensure_cfg "CONFIG_PACKAGE_luci-theme-kucat"
ensure_cfg "CONFIG_PACKAGE_luci-app-kucat-config"
ensure_cfg "CONFIG_PACKAGE_luci-compat"
ensure_cfg "CONFIG_PACKAGE_luci-lib-ipkg"
ensure_cfg "CONFIG_PACKAGE_curl"

# 让 Kconfig 重新结算依赖（这一步很关键）
make defconfig

echo ">>> [KUCAT] Verify final .config..."
grep -q "^CONFIG_PACKAGE_luci-app-kucat-config=y$" .config || {
  echo "❌ [KUCAT] Still missing: CONFIG_PACKAGE_luci-app-kucat-config=y"
  echo "   你需要检查：该插件 Makefile 的 DEPENDS 是否在 24.10 下满足（luci-base/curl 等）"
  exit 1
}
echo "✅ [KUCAT] luci-app-kucat-config is selected in final .config"
#==================== KUCAT_POSTFIX_END ======================
EOF

  echo ">>> Injected Kucat post-fix into: $DIY_PT2_SH"
}

inject_post_fix

#=========================================================
# 3) 后台IP设置
#=========================================================
export Ipv4_ipaddr="192.168.6.2"            # 修改openwrt后台地址(填0为关闭)
export Netmask_netm="255.255.255.0"         # IPv4 子网掩码（默认：255.255.255.0）(填0为不作修改)
export Op_name="OP-Shine"                   # 修改主机名称(填0为不作修改)

#=========================================================
# 4) 内核和系统分区大小(不是每个机型都可用)
#=========================================================
export Kernel_partition_size="0"            # 内核分区大小(填0为不作修改)
export Rootfs_partition_size="0"            # 系统分区大小(填0为不作修改)

#=========================================================
# 5) 默认主题设置
#=========================================================
export Mandatory_theme="argon"              # 必选主题(填0为不作修改)
export Default_theme="kucat"                # 默认主题(填0为不作修改) kucat argon

#=========================================================
# 6) 旁路由选项
#=========================================================
export Gateway_Settings="192.168.6.1"       # 网关(填0为不作修改)
export DNS_Settings="223.5.5.5"             # DNS(填0为不作修改)
export Broadcast_Ipv4="0"                   # 广播IP(填0为不作修改)
export Disable_DHCP="1"                     # 关闭DHCP(填0为不作修改)
export Disable_Bridge="1"                   # 去桥接(填0为不作修改)
export Create_Ipv6_Lan="1"                  # 创建IPv6 LAN(填0为不作修改)

#=========================================================
# 7) IPV6、IPV4 选择
#=========================================================
export Enable_IPV6_function="0"             # 编译IPV6固件(填0为不作修改)
export Enable_IPV4_function="0"             # 编译IPV4固件(填0为不作修改)

#=========================================================
# 8) 替换OpenClash源码
#=========================================================
export OpenClash_branch="0"                 # 0关闭,1 master,2 dev

#=========================================================
# 9) 个性签名
#=========================================================
export Customized_Information="༄Shine 🔸࿐ 编译于$(TZ=UTC-8 date "+%Y.%m.%d")"  # 填0为不作修改

#=========================================================
# 10) 更换固件内核
#=========================================================
export Replace_Kernel="0"                   # 填0为不作修改

#=========================================================
# 11) 免密码登录
#=========================================================
export Password_free_login="1"              # 填0为不作修改

#=========================================================
# 12) 增加AdGuardHome
#=========================================================
export AdGuardHome_Core="0"                 # 填0为不作修改

#=========================================================
# 13) NTFS挂载
#=========================================================
export Automatic_Mount_Settings="0"         # 填0为不作修改

#=========================================================
# 14) 去除网络共享(autosamba)
#=========================================================
export Disable_autosamba="1"                # 填0为不作修改

#=========================================================
# 15) 其他
#=========================================================
export Ttyd_account_free_login="1"
export Delete_unnecessary_items="0"
export Disable_53_redirection="0"
export Cancel_running="0"

#=========================================================
# 16) 晶晨CPU系列打包固件设置(不懂请看说明)
#=========================================================
export amlogic_model="s905d"
export amlogic_kernel="6.1.120_6.12.15"
export auto_kernel="true"
export rootfs_size="512/2560"
export kernel_usage="stable"

#=========================================================
# 17) 修改插件名字
#=========================================================
grep -rl '"终端"' . | xargs -r sed -i 's?"终端"?"TTYD"?g'
grep -rl '"TTYD 终端"' . | xargs -r sed -i 's?"TTYD 终端"?"TTYD"?g'
grep -rl '"网络存储"' . | xargs -r sed -i 's?"网络存储"?"NAS"?g'
grep -rl '"实时流量监测"' . | xargs -r sed -i 's?"实时流量监测"?"流量"?g'
grep -rl '"KMS 服务器"' . | xargs -r sed -i 's?"KMS 服务器"?"KMS激活"?g'
grep -rl '"USB 打印服务器"' . | xargs -r sed -i 's?"USB 打印服务器"?"打印服务"?g'
grep -rl '"Web 管理"' . | xargs -r sed -i 's?"Web 管理"?"Web管理"?g'
grep -rl '"管理权"' . | xargs -r sed -i 's?"管理权"?"改密码"?g'
grep -rl '"带宽监控"' . | xargs -r sed -i 's?"带宽监控"?"监控"?g'

#=========================================================
# 18) 整理固件包时候删除不需要的文件
#=========================================================
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

# 在线更新时删除不想保留文件
cat >>"$DELETE" <<-EOF
EOF
