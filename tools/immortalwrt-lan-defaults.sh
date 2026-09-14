#!/bin/sh

immortalwrt_network_error() {
	printf '默认网络配置失败: %s\n' "$*" >&2
	return 1
}

# 先检查完整设备关系，再修改 LAN；不能以丢失端口或其他接口换取“去桥接”。
immortalwrt_lan_bridge_plan() {
	local device data section name kind bridge ports port count candidate other reference
	device=$(uci -q get network.lan.device) || { immortalwrt_network_error 'LAN 设备不存在'; return 1; }
	data=$(uci -X show network) || return 1
	bridge=
	for section in $(printf '%s\n' "$data" | sed -n 's/^network\.\([a-zA-Z0-9_]*\)=device$/\1/p'); do
		name=$(uci -q get "network.$section.name") || continue
		kind=$(uci -q get "network.$section.type") || continue
		[ "$kind" = bridge ] || continue
		case "$device" in
			"$name".*) immortalwrt_network_error 'LAN 使用桥接 VLAN，无法自动去桥接'; return 1 ;;
		esac
		[ "$name" = "$device" ] || continue
		[ -z "$bridge" ] || { immortalwrt_network_error 'LAN 桥接设备不唯一'; return 1; }
		bridge=$section
	done
	[ -n "$bridge" ] || return 0
	ports=$(uci -q get "network.$bridge.ports") || { immortalwrt_network_error 'LAN 桥接端口不存在'; return 1; }
	case "$ports" in
		''|*[!a-zA-Z0-9_.:\ -]*) immortalwrt_network_error 'LAN 桥接端口格式无效'; return 1 ;;
	esac
	count=0
	port=
	for candidate in $ports; do count=$((count + 1)); port=$candidate; done
	[ "$count" = 1 ] || { immortalwrt_network_error 'LAN 有多个桥接端口，需要明确选择 LAN 端口'; return 1; }
	for other in $(printf '%s\n' "$data" | sed -n 's/^network\.\([a-zA-Z0-9_]*\)=[^.]*$/\1/p'); do
		[ "$other" != lan ] && [ "$other" != "$bridge" ] || continue
		reference=$(uci -q get "network.$other.device") || continue
		case "$reference" in
			"$device"|"$device".*) immortalwrt_network_error 'LAN 桥还被其他接口或 VLAN 使用'; return 1 ;;
		esac
	done
	printf '%s %s\n' "$bridge" "$port"
}

immortalwrt_apply_lan_defaults() {
	local gateway dns broadcast disable_dhcp disable_bridge ttyd_free plan section port first server
	gateway=$1
	dns=$2
	broadcast=$3
	disable_dhcp=$4
	disable_bridge=$5
	ttyd_free=$6
	uci -q get network.lan >/dev/null || { immortalwrt_network_error 'LAN 接口未生成'; return 1; }
	plan=
	if [ "$disable_bridge" = 1 ]; then
		plan=$(immortalwrt_lan_bridge_plan) || return 1
	fi
	if [ "$gateway" != 0 ]; then uci set "network.lan.gateway=$gateway" || return 1; fi
	if [ "$dns" != 0 ]; then
		first=1
		for server in $dns; do
			if [ "$first" = 1 ]; then
				uci set "network.lan.dns=$server" || return 1
				first=0
			else
				uci add_list "network.lan.dns=$server" || return 1
			fi
		done
	fi
	if [ "$broadcast" != 0 ]; then uci set "network.lan.broadcast=$broadcast" || return 1; fi
	if [ "$disable_dhcp" = 1 ]; then uci set dhcp.lan.ignore=1 || return 1; fi
	if [ "$disable_bridge" = 1 ]; then
		if [ -n "$plan" ]; then
			section=${plan%% *}
			port=${plan#* }
			uci set "network.lan.device=$port" || return 1
			uci delete "network.$section" || return 1
		fi
		if uci -q get network.lan.type >/dev/null; then uci delete network.lan.type || return 1; fi
	fi
	if [ "$ttyd_free" = 1 ]; then
		if [ -f /etc/config/ttyd ]; then
			uci set 'ttyd.@ttyd[0].command=/bin/login -f root' || return 1
		else
			printf 'TTYD 未安装，免账户登录设置不适用\n'
		fi
	fi
}
