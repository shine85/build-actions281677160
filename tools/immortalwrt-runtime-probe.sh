#!/bin/sh

. /usr/share/libubox/jshn.sh
. /lib/functions.sh
board=$(ubus call system board) || exit 1
lan=$(ubus call network.interface.lan status) || exit 1
dnsmasq=$(ubus call service list '{"name":"dnsmasq"}') || exit 1
uhttpd=$(ubus call service list '{"name":"uhttpd"}') || exit 1
uci -q show network >/dev/null || exit 1

json_init
json_add_string board_json "$board"
json_add_string lan_json "$lan"
json_add_string dnsmasq_json "$dnsmasq"
json_add_string uhttpd_json "$uhttpd"
if [ -f /rom/etc/uci-defaults/99-first-run ] && [ ! -e /etc/uci-defaults/99-first-run ] && [ ! -L /etc/uci-defaults/99-first-run ]; then
	json_add_boolean startupComplete 1
else
	json_add_boolean startupComplete 0
fi
json_add_object uci
for pair in address:network.lan.ipaddr netmask:network.lan.netmask gateway:network.lan.gateway dns:network.lan.dns device:network.lan.device dhcpIgnore:dhcp.lan.ignore theme:luci.main.mediaurlbase \
	ip6assign:network.lan.ip6assign delegate:network.lan.delegate ra:dhcp.lan.ra raManagement:dhcp.lan.ra_management raDefault:dhcp.lan.ra_default dhcpv6:dhcp.lan.dhcpv6 ndp:dhcp.lan.ndp \
	ipv6Proto:network.ipv6.proto ipv6Device:network.ipv6.device reqaddress:network.ipv6.reqaddress reqprefix:network.ipv6.reqprefix filterAaaa:dhcp.@dnsmasq[0].filter_aaaa ulaPrefix:network.globals.ula_prefix wan6:network.wan6; do
	key=${pair%%:*}
	option=${pair#*:}
	if value=$(uci -q get "$option"); then json_add_string "$key" "$value"; else json_add_null "$key"; fi
done
json_close_object
json_add_array bridges
for bridge in /sys/class/net/*/bridge; do
	[ -d "$bridge" ] || continue
	device=${bridge%/bridge}
	json_add_string '' "${device##*/}"
done
json_close_array
json_add_array links
for link in /sys/class/net/*/lower_*; do
	[ -L "$link" ] || continue
	device=${link%/*}
	lower=${link##*/}
	json_add_object ''
	json_add_string device "${device##*/}"
	json_add_string lower "${lower#lower_}"
	json_close_object
done
json_close_array
json_add_array firewallLanNetworks
immortalwrt_firewall_lan() {
	local networks interface
	config_get networks "$1" network
	case " $networks " in
		*' lan '*) for interface in $networks; do json_add_string '' "$interface"; done ;;
	esac
}
config_load firewall
config_foreach immortalwrt_firewall_lan zone
json_close_array
if [ -f /lib/apk/db/installed ]; then
	packages=$(awk -F: '$1 == "P" { print $2 }' /lib/apk/db/installed) || exit 1
elif [ -f /usr/lib/opkg/status ]; then
	packages=$(awk 'BEGIN { RS="" } /Status:.* installed/ { for (i=1; i<=NF; i++) if ($i=="Package:") print $(i+1) }' /usr/lib/opkg/status) || exit 1
else
	printf '无法读取实际安装的软件包数据库\n' >&2
	exit 1
fi
json_add_array packages
for package in $packages; do json_add_string '' "$package"; done
json_close_array
if [ -d /sys/firmware/efi ]; then json_add_boolean efi 1; else json_add_boolean efi 0; fi
json_dump
