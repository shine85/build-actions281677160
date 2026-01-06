#!/bin/bash
# Copyright (c) 2019-2020 P3TERX <https://p3terx.com>
# DIY扩展二合一了，在此处可以增加插件
# 自行拉取插件之前请SSH连接进入固件配置里面确认过没有你要的插件再单独拉取你需要的插件
# 不要一下就拉取别人一个插件包N多插件的，多了没用，增加编译错误，自己需要的才好

#========================================================
# 主题
#========================================================
git clone --depth 1 https://github.com/sirpdboy/luci-theme-kucat package/luci-theme-kucat
git clone --depth 1 https://github.com/sirpdboy/luci-app-kucat-config package/luci-app-kucat-config


#========================================================
# 后台IP设置
#========================================================
export Ipv4_ipaddr="192.168.6.2"            # 修改openwrt后台地址(填0为关闭)
export Netmask_netm="255.255.255.0"         # IPv4 子网掩码（默认：255.255.255.0）(填0为不作修改)
export Op_name="OP-Shine"                   # 修改主机名称(填0为不作修改)

# 内核和系统分区大小(不是每个机型都可用)
export Kernel_partition_size="0"            # 内核分区大小(填0为不作修改)
export Rootfs_partition_size="0"            # 系统分区大小(填0为不作修改)

# 默认主题设置
export Mandatory_theme="argon"              # 将bootstrap替换为必选主题(填0为不作修改)
export Default_theme="kucat"                # 多主题时,选择某主题为默认第一主题(填0为不作修改)

# 旁路由选项
export Gateway_Settings="192.168.6.1"       # IPv4 网关(填0为不作修改)
export DNS_Settings="223.5.5.5"             # DNS(多个DNS空格分开)(填0为不作修改)
export Broadcast_Ipv4="0"                   # 广播IP(填0为不作修改)
export Disable_DHCP="1"                     # 关闭DHCP(填0为不作修改)
export Disable_Bridge="1"                   # 去掉桥接(填0为不作修改)
export Create_Ipv6_Lan="1"                  # 创建IPV6 LAN(填0为不作修改)

# IPV6、IPV4 选择
export Enable_IPV6_function="0"             # 编译IPV6固件(填0为不作修改)
export Enable_IPV4_function="0"             # 编译IPV4固件(填0为不作修改)

# 替换OpenClash的源码(默认master分支)
export OpenClash_branch="0"                 # 0关闭,1 master,2 dev

# 个性签名
export Customized_Information="༄Shine 🔸࿐ 编译于$(TZ=UTC-8 date "+%Y.%m.%d")"  # (填0为不作修改)

# 更换固件内核
export Replace_Kernel="0"                   # (填0为不作修改)

# 设置免密码登录
export Password_free_login="1"              # (填0为不作修改)

# 增加AdGuardHome插件和核心
export AdGuardHome_Core="0"                 # (填0为不作修改)

# 开启NTFS格式盘挂载
export Automatic_Mount_Settings="0"         # (填0为不作修改)

# 去除网络共享(autosamba)
export Disable_autosamba="1"                # (填0为不作修改)

# 其他
export Ttyd_account_free_login="1"          # (填0为不作修改)
export Delete_unnecessary_items="0"         # (填0为不作修改)
export Disable_53_redirection="0"           # (填0为不作修改)
export Cancel_running="0"                   # (填0为不作修改)

# 晶晨CPU系列打包固件设置(不懂请看说明)
export amlogic_model="s905d"
export amlogic_kernel="6.1.120_6.12.15"
export auto_kernel="true"
export rootfs_size="512/2560"
export kernel_usage="stable"


#========================================================
# 修改插件名字
#========================================================
grep -rl '"终端"' . | xargs -r sed -i 's?"终端"?"TTYD"?g'
grep -rl '"TTYD 终端"' . | xargs -r sed -i 's?"TTYD 终端"?"TTYD"?g'
grep -rl '"网络存储"' . | xargs -r sed -i 's?"网络存储"?"NAS"?g'
grep -rl '"实时流量监测"' . | xargs -r sed -i 's?"实时流量监测"?"流量"?g'
grep -rl '"KMS 服务器"' . | xargs -r sed -i 's?"KMS 服务器"?"KMS激活"?g'
grep -rl '"USB 打印服务器"' . | xargs -r sed -i 's?"USB 打印服务器"?"打印服务"?g'
grep -rl '"Web 管理"' . | xargs -r sed -i 's?"Web 管理"?"Web管理"?g'
grep -rl '"管理权"' . | xargs -r sed -i 's?"管理权"?"改密码"?g'
grep -rl '"带宽监控"' . | xargs -r sed -i 's?"带宽监控"?"监控"?g'


#========================================================
# 整理固件包
#========================================================
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

cat >>$DELETE <<-EOF
EOF


#========================================================
# ✅ 关键修复：确保 luci-app-kucat-config 进入最终 .config 且不被 defconfig 清洗
#   - 写入 seed（$MYCONFIG_FILE）: 这是你 Actions 里最关键的来源
#   - 同时写入 OpenWrt 根目录 .config 并 make defconfig：双保险
#========================================================
ensure_kconfig_line() {
  # $1: file  $2: KEY=VAL (例如 CONFIG_PACKAGE_xxx=y)
  local f="$1"
  local kv="$2"
  local k="${kv%%=*}"

  [ -f "$f" ] || touch "$f"

  # 删除已有同名KEY行（含 is not set）
  sed -i "/^${k}=.*/d" "$f"
  sed -i "/^# ${k} is not set/d" "$f"

  echo "$kv" >> "$f"
}

apply_kucat_config() {
  local target_file="$1"
  echo "Applying kucat packages into: $target_file"

  ensure_kconfig_line "$target_file" "CONFIG_PACKAGE_luci-theme-kucat=y"
  ensure_kconfig_line "$target_file" "CONFIG_PACKAGE_luci-app-kucat-config=y"
  ensure_kconfig_line "$target_file" "CONFIG_PACKAGE_luci-compat=y"
  ensure_kconfig_line "$target_file" "CONFIG_PACKAGE_luci-lib-ipkg=y"

  # 该插件/主题常见依赖（避免 defconfig 认为不可见而清掉）
  ensure_kconfig_line "$target_file" "CONFIG_PACKAGE_curl=y"
}

# 1) 写入 seed/x86_64（最关键）
if [ -n "$MYCONFIG_FILE" ]; then
  apply_kucat_config "$MYCONFIG_FILE"
  echo "Kucat seed config written to: $MYCONFIG_FILE"
fi

# 2) 同时写入 OpenWrt 根目录的 .config 并 defconfig（双保险）
if [ -f "./rules.mk" ]; then
  apply_kucat_config ".config"
  make defconfig
fi
