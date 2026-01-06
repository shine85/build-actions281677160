#!/bin/bash
# Copyright (c) 2019-2020 P3TERX <https://p3terx.com>
# DIY扩展二合一了，在此处可以增加插件
# 自行拉取插件之前请SSH连接进入固件配置里面确认过没有你要的插件再单独拉取你需要的插件
# 不要一下就拉取别人一个插件包N多插件的，多了没用，增加编译错误，自己需要的才好

set -e

# ======================
# 主题（Kucat）
# ======================
rm -rf package/luci-theme-kucat package/luci-app-kucat-config

git clone --depth 1 https://github.com/sirpdboy/luci-theme-kucat package/luci-theme-kucat
git clone --depth 1 https://github.com/sirpdboy/luci-app-kucat-config package/luci-app-kucat-config

# ImmortalWrt 24.10 下：luci-app-kucat-config 的 Makefile 里有 host/build 依赖，会导致 defconfig 直接清洗掉该包
# 这里直接删除这些依赖，让 Kconfig 变成“可选”，从而能进最终 .config 与固件
KUCAT_MK="package/luci-app-kucat-config/Makefile"
if [ -f "$KUCAT_MK" ]; then
  echo ">>> Patch luci-app-kucat-config Makefile for ImmortalWrt 24.10"
  sed -i \
    -e '/luci-base\/host/d' \
    -e '/csstidy\/host/d' \
    -e '/luasrcdiet\/host/d' \
    -e '/+curl/d' \
    "$KUCAT_MK"
fi

# ======================
# 后台IP设置
# ======================
export Ipv4_ipaddr="192.168.6.2"            # 修改openwrt后台地址(填0为关闭)
export Netmask_netm="255.255.255.0"         # IPv4 子网掩码（默认：255.255.255.0）(填0为不作修改)
export Op_name="OP-Shine"                   # 修改主机名称(填0为不作修改)

# 内核和系统分区大小(不是每个机型都可用)
export Kernel_partition_size="0"            # 内核分区大小(填0为不作修改)
export Rootfs_partition_size="0"            # 系统分区大小(填0为不作修改)

# 默认主题设置
export Mandatory_theme="argon"              # bootstrap替换为必选主题(填0为不作修改)
export Default_theme="kucat"                # 多主题时默认第一主题(填0为不作修改)

# 旁路由选项
export Gateway_Settings="192.168.6.1"       # 旁路由网关(填0为不作修改)
export DNS_Settings="223.5.5.5"             # 旁路由DNS(填0为不作修改)
export Broadcast_Ipv4="0"                   # IPv4广播(填0为不作修改)
export Disable_DHCP="1"                     # 旁路由关闭DHCP(填0为不作修改)
export Disable_Bridge="1"                   # 去掉桥接模式(填0为不作修改)
export Create_Ipv6_Lan="1"                  # 创建IPv6 LAN(填0为不作修改)

# IPV6、IPV4 选择
export Enable_IPV6_function="0"
export Enable_IPV4_function="0"

# 替换OpenClash源码
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

# ======================
# 修改插件名字
# ======================
grep -rl '"终端"' . | xargs -r sed -i 's?"终端"?"TTYD"?g'
grep -rl '"TTYD 终端"' . | xargs -r sed -i 's?"TTYD 终端"?"TTYD"?g'
grep -rl '"网络存储"' . | xargs -r sed -i 's?"网络存储"?"NAS"?g'
grep -rl '"实时流量监测"' . | xargs -r sed -i 's?"实时流量监测"?"流量"?g'
grep -rl '"KMS 服务器"' . | xargs -r sed -i 's?"KMS 服务器"?"KMS激活"?g'
grep -rl '"USB 打印服务器"' . | xargs -r sed -i 's?"USB 打印服务器"?"打印服务"?g'
grep -rl '"Web 管理"' . | xargs -r sed -i 's?"Web 管理"?"Web管理"?g'
grep -rl '"管理权"' . | xargs -r sed -i 's?"管理权"?"改密码"?g'
grep -rl '"带宽监控"' . | xargs -r sed -i 's?"带宽监控"?"监控"?g'

# ======================
# 整理固件包时删除不需要上传的文件
# ======================
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

# ======================
# 关键：写入 seed（不是写 .config）
# ======================
_seed="${MYCONFIG_FILE:-}"
if [ -z "${_seed}" ]; then
  _seed="x86_64"
fi
mkdir -p "$(dirname "${_seed}")" 2>/dev/null || true
touch "${_seed}" 2>/dev/null || true

_append_cfg() {
  local line="$1"
  grep -qxF "${line}" "${_seed}" 2>/dev/null || echo "${line}" >> "${_seed}"
}

# 依赖 + 主题 + 配置插件（确保最终 .config 能保留下来）
_append_cfg "CONFIG_PACKAGE_luci-compat=y"
_append_cfg "CONFIG_PACKAGE_luci-lib-ipkg=y"
_append_cfg "CONFIG_PACKAGE_luci-theme-kucat=y"
_append_cfg "CONFIG_PACKAGE_luci-app-kucat-config=y"

echo "Kucat seed config written to: ${_seed}"
