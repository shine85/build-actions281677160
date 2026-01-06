#!/bin/bash
# Copyright (c) 2019-2020 P3TERX <https://p3terx.com>
# DIY扩展二合一了，在此处可以增加插件
# 自行拉取插件之前请SSH连接进入固件配置里面确认过没有你要的插件再单独拉取你需要的插件
# 不要一下就拉取别人一个插件包N多插件的，多了没用，增加编译错误，自己需要的才好

set -e

# -------------------------------------------------------
# 0) 确保在 OpenWrt 根目录执行（非常关键）
# -------------------------------------------------------
[ -f "./rules.mk" ] || { echo "Not in OpenWrt root dir (rules.mk not found)"; exit 1; }

# -------------------------------------------------------
# 1) 主题 & 插件：kucat + kucat-config
#    关键修复：先 clone → 立刻 feeds update/install → 再写 .config/seed → make defconfig
# -------------------------------------------------------
rm -rf package/luci-theme-kucat package/luci-app-kucat-config

git clone --depth 1 https://github.com/sirpdboy/luci-theme-kucat package/luci-theme-kucat
git clone --depth 1 https://github.com/sirpdboy/luci-app-kucat-config package/luci-app-kucat-config

# 让 Kconfig / feeds 先就绪，避免 defconfig 清洗掉“当时不可见”的 CONFIG
if [ -x "./scripts/feeds" ]; then
  ./scripts/feeds update -a
  ./scripts/feeds install -a
fi

# 写入 seed（你的 workflow 最终会用它生成 .config）
# MYCONFIG_FILE 在 Actions 环境里一定会有；本地没有也不报错
if [ -n "$MYCONFIG_FILE" ]; then
  mkdir -p "$(dirname "$MYCONFIG_FILE")"
  touch "$MYCONFIG_FILE"
  # 去重写入
  sed -i '/^CONFIG_PACKAGE_luci-theme-kucat=/d' "$MYCONFIG_FILE" || true
  sed -i '/^CONFIG_PACKAGE_luci-app-kucat-config=/d' "$MYCONFIG_FILE" || true
  sed -i '/^CONFIG_PACKAGE_luci-compat=/d' "$MYCONFIG_FILE" || true
  sed -i '/^CONFIG_PACKAGE_luci-lib-ipkg=/d' "$MYCONFIG_FILE" || true

  cat >>"$MYCONFIG_FILE" <<'EOF'
CONFIG_PACKAGE_luci-theme-kucat=y
CONFIG_PACKAGE_luci-app-kucat-config=y
CONFIG_PACKAGE_luci-compat=y
CONFIG_PACKAGE_luci-lib-ipkg=y
EOF

  echo "Kucat seed config written to: $MYCONFIG_FILE"
fi

# 同步写入当前 .config（有的 workflow 会先用 seed 生成 .config，有的会先用 .config）
touch .config
sed -i '/^CONFIG_PACKAGE_luci-theme-kucat=/d' .config || true
sed -i '/^CONFIG_PACKAGE_luci-app-kucat-config=/d' .config || true
sed -i '/^CONFIG_PACKAGE_luci-compat=/d' .config || true
sed -i '/^CONFIG_PACKAGE_luci-lib-ipkg=/d' .config || true

cat >> .config <<'EOF'
CONFIG_PACKAGE_luci-theme-kucat=y
CONFIG_PACKAGE_luci-app-kucat-config=y
CONFIG_PACKAGE_luci-compat=y
CONFIG_PACKAGE_luci-lib-ipkg=y
EOF

# 固化依赖与可见性（此时 feeds 已就绪，不会被清洗成“无效项”）
make defconfig

# -------------------------------------------------------
# 后台IP设置
# -------------------------------------------------------
export Ipv4_ipaddr="192.168.6.2"            # 修改openwrt后台地址(填0为关闭)
export Netmask_netm="255.255.255.0"         # IPv4 子网掩码（默认：255.255.255.0）(填0为不作修改)
export Op_name="OP-Shine"                   # 修改主机名称(填0为不作修改)

# 内核和系统分区大小(不是每个机型都可用)
export Kernel_partition_size="0"
export Rootfs_partition_size="0"

# 默认主题设置
export Mandatory_theme="argon"              # bootstrap替换成必选主题
export Default_theme="kucat"                # 默认第一主题

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

# 修改插件名字
grep -rl '"终端"' . | xargs -r sed -i 's?"终端"?"TTYD"?g'
grep -rl '"TTYD 终端"' . | xargs -r sed -i 's?"TTYD 终端"?"TTYD"?g'
grep -rl '"网络存储"' . | xargs -r sed -i 's?"网络存储"?"NAS"?g'
grep -rl '"实时流量监测"' . | xargs -r sed -i 's?"实时流量监测"?"流量"?g'
grep -rl '"KMS 服务器"' . | xargs -r sed -i 's?"KMS 服务器"?"KMS激活"?g'
grep -rl '"USB 打印服务器"' . | xargs -r sed -i 's?"USB 打印服务器"?"打印服务"?g'
grep -rl '"Web 管理"' . | xargs -r sed -i 's?"Web 管理"?"Web管理"?g'
grep -rl '"管理权"' . | xargs -r sed -i 's?"管理权"?"改密码"?g'
grep -rl '"带宽监控"' . | xargs -r sed -i 's?"带宽监控"?"监控"?g'

# 整理固件包时候,删除您不想要的固件或者文件,让它不需要上传到Actions空间
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

# 在线更新时删除不想保留固件的某个文件
cat >>"$DELETE" <<-EOF
EOF
