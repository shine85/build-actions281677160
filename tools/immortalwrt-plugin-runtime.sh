#!/bin/sh
# 只能由隔离 COW 虚拟机驱动调用；所有测试服务仅监听回环地址。

fail() { printf '插件运行烟测失败: %s\n' "$*" >&2; exit 1; }
. /usr/share/libubox/jshn.sh || exit 1
work=$(mktemp -d /tmp/immortalwrt-plugin-runtime.XXXXXX) || exit 1
restores=
pids=
cleaned=0
homeproxy_output=0

stop_processes() {
  local stop_error=0 pid code
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" || stop_error=1
      wait "$pid"
      code=$?
      [ "$code" = 0 ] || [ "$code" = 143 ] || stop_error=1
    else
      stop_error=1
    fi
  done
  pids=
  return "$stop_error"
}

restore_configs() {
  local name artifact
  for name in $restores; do
    cp -p "$work/$name.original" "/etc/config/$name" || return 1
    cmp -s "$work/$name.original" "/etc/config/$name" || return 1
  done
  restores=
  if [ "$homeproxy_output" = 1 ]; then
    for artifact in sing-box-s.json sing-box-s.log; do
      if [ -f "$work/$artifact.original" ]; then
        cp -p "$work/$artifact.original" "/var/run/homeproxy/$artifact" || return 1
        cmp -s "$work/$artifact.original" "/var/run/homeproxy/$artifact" || return 1
      else
        rm -f "/var/run/homeproxy/$artifact" || return 1
      fi
    done
    homeproxy_output=0
  fi
}

cleanup() {
  local cleanup_status=$?
  trap - EXIT HUP INT TERM
  if [ "$cleaned" != 1 ]; then
    stop_processes || { printf '测试进程清理失败\n' >&2; cleanup_status=1; }
    restore_configs || { printf '插件配置恢复失败\n' >&2; cleanup_status=1; }
  fi
  case "$work" in
    /tmp/immortalwrt-plugin-runtime.*) rm -rf -- "$work" || cleanup_status=1 ;;
    *) printf '插件临时目录越界\n' >&2; cleanup_status=1 ;;
  esac
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

backup_config() {
  local name=$1 pending
  pending=$(uci changes "$name") || fail "$name UCI 状态不可读"
  [ -z "$pending" ] || fail "$name 存在未提交 UCI 修改，不能覆盖"
  cp -p "/etc/config/$name" "$work/$name.original" || fail "$name 配置备份失败"
  cmp -s "/etc/config/$name" "$work/$name.original" || fail "$name 配置备份不一致"
  restores="$restores $name"
}

cron_digest() {
  if [ -f /etc/crontabs/root ]; then sha256sum /etc/crontabs/root; else printf 'absent\n'; fi
}
cron_before=$(cron_digest) || fail '无法读取 cron'

has_plugin() { case " $PLUGIN_PACKAGES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
config_readable() { uci -q export "$1" >/dev/null || fail "$1 配置不可读"; }
bytes() { wc -c < "$1" | tr -d ' '; }
file_digest() { sha256sum "$1" | cut -d ' ' -f 1; }

get_local() {
  local url=$1 output=$2
  shift 2
  curl --silent --show-error --fail --max-time 3 --proxy '' --noproxy '' "$@" "$url" -o "$output" -w '%{http_code}'
}

wait_http() {
  local url=$1 output=$2 attempt log
  shift 2
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    if http_status=$(get_local "$url" "$output" "$@" 2>"$work/http-error"); then
      [ "$http_status" = 200 ] || fail "本机 HTTP 状态异常: $http_status"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  cat "$work/http-error" >&2
  for log in "$work"/*-run.log "$work/frpc.log" "$work/http.log"; do
    [ ! -f "$log" ] || tail -n 15 "$log" >&2
  done
  fail "本机 HTTP 服务未就绪: $url"
}

if has_plugin luci-app-homeproxy || has_plugin luci-app-nikki; then
  command -v curl >/dev/null || fail '缺少本机请求所需 curl'
fi
if has_plugin luci-app-homeproxy || has_plugin luci-app-nikki; then
  mkdir "$work/www" || fail '无法创建本机响应目录'
  printf 'immortalwrt-plugin-local-ok\n' > "$work/www/probe.txt" || fail '无法写入本机响应'
  uhttpd -f -p 127.0.0.1:18130 -h "$work/www" >"$work/http.log" 2>&1 &
  pids="$pids $!"
  wait_http http://127.0.0.1:18130/probe.txt "$work/direct-response"
  cmp -s "$work/direct-response" "$work/www/probe.txt" || fail '本机 HTTP 测试服务响应错误'
fi

json_init
json_add_object plugins
for package in $PLUGIN_PACKAGES; do
  name=${package#luci-app-}
  json_add_object "$package"
  if [ "$name" != autoupdate ]; then
    menu=$(cat "/usr/share/luci/menu.d/$package.json") || fail "$package 菜单缺失"
    json_add_string menu "$menu"
  fi
  json_add_object runtime
  case "$name" in
    autoreboot)
      sh -n /etc/init.d/autoreboot || fail 'autoreboot 脚本语法错误'
      config_readable autoreboot
      mkdir "$work/autoreboot-uci" || fail 'autoreboot 临时配置目录失败'
      cat > "$work/autoreboot-uci/autoreboot" <<'EOF'
config schedule 'smoke'
  option enabled '1'
  option minute '17'
  option hour '3'
  option day '*'
  option month '*'
  option week '2'
EOF
      (
        . /lib/functions.sh || exit 1
        . /etc/init.d/autoreboot || exit 1
        UCI_CONFIG_DIR="$work/autoreboot-uci"
        CRON_FILE="$work/autoreboot.cron"
        config_load autoreboot || exit 1
        setup_cron smoke
      ) || fail 'autoreboot 原生计划生成器失败'
      schedule=$(cat "$work/autoreboot.cron") || fail 'autoreboot 未生成计划'
      json_add_int shellSyntaxExit 0
      json_add_boolean configReadable 1
      json_add_string generatedSchedule "$schedule"
      json_add_boolean installedSchedule 0
      ;;
    autoupdate)
      sh -n /usr/bin/AutoUpdate && sh -n /etc/init.d/autoupdate || fail 'autoupdate 脚本语法错误'
      lua -e 'assert(loadfile("/usr/lib/lua/luci/controller/autoupdate.lua")); assert(loadfile("/usr/lib/lua/luci/model/cbi/autoupdate/autoupdate.lua"))' || fail 'autoupdate Lua 语法错误'
      config_readable autoupdate
      test -s /etc/openwrt_update && grep -q '^FIRMWARE_VERSION=' /etc/openwrt_update && grep -q '^GITHUB_LINK=' /etc/openwrt_update || fail 'autoupdate 更新元数据缺失'
      json_add_int shellSyntaxExit 0
      json_add_int luaSyntaxExit 0
      json_add_boolean configReadable 1
      json_add_boolean metadataReadable 1
      ;;
    firewall)
      fw4 check >"$work/fw4-check.log" 2>&1 || { cat "$work/fw4-check.log" >&2; fail 'firewall 规则校验失败'; }
      fw4 print >"$work/fw4.nft" 2>"$work/fw4-print.log" || fail 'firewall 无法生成规则'
      nft -j list table inet fw4 >"$work/fw4-loaded.json" || fail 'firewall 未加载 fw4 表'
      chains=$(jsonfilter -i "$work/fw4-loaded.json" -e '$.nftables[*].chain.name') || fail 'firewall 无法读取已加载链'
      json_add_int configCheckExit 0
      json_add_int generatedBytes "$(bytes "$work/fw4.nft")"
      json_add_array loadedChains
      for chain in $chains; do json_add_string '' "$chain"; done
      json_close_array
      ;;
    frpc)
      config_readable frpc
      mkdir "$work/frpc-uci" || fail 'frpc 临时配置目录失败'
      cat > "$work/frpc-uci/frpc" <<'EOF'
config init 'init'
  option stdout '1'
  option stderr '1'
config conf 'common'
  option server_addr '127.0.0.1'
  option server_port '1'
  option login_fail_exit 'true'
  option log_level 'warn'
EOF
      (
        . /lib/functions.sh || exit 1
        . /etc/init.d/frpc || exit 1
        UCI_CONFIG_DIR="$work/frpc-uci"
        conf_file="$work/frpc.ini"
        : > "$conf_file" || exit 1
        config_load frpc
      ) || fail 'frpc 原生 UCI 配置生成器失败'
      frpc --help > "$work/frpc-help" 2>&1 || fail 'frpc 核心无法执行'
      core_version=$(frpc -v) || fail 'frpc 核心版本读取失败'
      [ -n "$core_version" ] || fail 'frpc 核心版本为空'
      method=startup-parser
      if grep -q '^[[:space:]]*verify[[:space:]]' "$work/frpc-help"; then
        frpc verify -c "$work/frpc.ini" >"$work/frpc-check.log" 2>&1 || { cat "$work/frpc-check.log" >&2; fail 'frpc 核心配置校验失败'; }
        method=verify
      fi
      frpc -c "$work/frpc.ini" >"$work/frpc.log" 2>&1
      startup_exit=$?
      diagnostic=$(grep -F '127.0.0.1:1' "$work/frpc.log" | grep -i 'connection refused' | head -n 1)
      { [ "$startup_exit" = 1 ] || { [ "$core_version" = 0.51.3 ] && [ "$startup_exit" = 0 ]; }; } &&
        [ -n "$diagnostic" ] || { cat "$work/frpc.log" >&2; fail 'frpc 未到达预期的本机连接失败路径'; }
      json_add_string coreVersion "$core_version"
      json_add_int configBytes "$(bytes "$work/frpc.ini")"
      json_add_string configCheckMethod "$method"
      if [ "$method" = verify ]; then json_add_int configCheckExit 0; else json_add_null configCheckExit; fi
      json_add_int startupExit "$startup_exit"
      json_add_string startupDiagnostic "$diagnostic"
      ;;
    homeproxy)
      config_readable homeproxy
      ubus call luci.homeproxy acllist_read '{"type":"direct_list"}' >"$work/homeproxy-rpc.json" || fail 'homeproxy 只读 RPC 失败'
      backup_config homeproxy
      mkdir -p /var/run/homeproxy || fail 'homeproxy 运行目录不可用'
      for artifact in sing-box-s.json sing-box-s.log; do
        if [ -e "/var/run/homeproxy/$artifact" ]; then
          cp -p "/var/run/homeproxy/$artifact" "$work/$artifact.original" || fail 'homeproxy 原运行文件备份失败'
          cmp -s "/var/run/homeproxy/$artifact" "$work/$artifact.original" || fail 'homeproxy 原运行文件备份不一致'
        fi
      done
      homeproxy_output=1
      : > /var/run/homeproxy/sing-box-s.json || fail 'homeproxy 无法清空生成目标'
      cat > /etc/config/homeproxy <<'EOF'
config homeproxy 'server'
  option enabled '1'
  option log_level 'warn'
config server 'smoke'
  option enabled '1'
  option type 'http'
  option address '127.0.0.1'
  option port '18131'
  option username 'local-smoke'
  option password 'local-smoke'
EOF
      ucode -S /etc/homeproxy/scripts/generate_server.uc >"$work/homeproxy-generate.log" 2>&1 || { cat "$work/homeproxy-generate.log" >&2; fail 'homeproxy 配置生成失败'; }
      cp /var/run/homeproxy/sing-box-s.json "$work/homeproxy.json" || fail 'homeproxy 未生成服务端配置'
      sing-box check --config "$work/homeproxy.json" >"$work/homeproxy-check.log" 2>&1 || { cat "$work/homeproxy-check.log" >&2; fail 'homeproxy 核心配置校验失败'; }
      sing-box run --config "$work/homeproxy.json" >"$work/homeproxy-run.log" 2>&1 &
      pids="$pids $!"
      wait_http http://127.0.0.1:18130/probe.txt "$work/homeproxy-response" --proxy http://127.0.0.1:18131 --proxy-user local-smoke:local-smoke
      cmp -s "$work/homeproxy-response" "$work/www/probe.txt" || fail 'homeproxy 本机代理响应错误'
      json_add_int generatorExit 0
      json_add_int generatedBytes "$(bytes "$work/homeproxy.json")"
      json_add_int configCheckExit 0
      json_add_int localHttpStatus "$http_status"
      json_add_string localResponseSha256 "$(file_digest "$work/homeproxy-response")"
      json_add_boolean rpcAvailable 1
      ;;
    kucat-config)
      sh -n /usr/bin/kucat-config || fail 'kucat-config 脚本语法错误'
      config_readable kucat
      backup_config kucat
      cat > /etc/config/kucat <<'EOF'
config basic 'basic'
  option fontmode '2'
config theme 'smoke'
  option use '1'
  option mode 'dark'
  option primary_rgbm 'green'
  option bkuse '1'
  option primary_rgbs_ts '0.2'
EOF
      /usr/bin/kucat-config >"$work/kucat.log" 2>&1 || { cat "$work/kucat.log" >&2; fail 'kucat 配色应用失败'; }
      json_add_int shellSyntaxExit 0
      json_add_boolean configReadable 1
      json_add_object applied
      for option in mode primary_rgbm font_d; do
        value=$(uci -q get "kucat.@basic[0].$option") || fail "kucat 未应用 $option"
        json_add_string "$option" "$value"
      done
      json_close_object
      ;;
    nikki)
      config_readable nikki
      ubus call luci.nikki version '{}' >"$work/nikki-rpc.json" || fail 'nikki 只读版本 RPC 失败'
      backup_config nikki
      cat > /etc/config/nikki <<'EOF'
config mixin 'mixin'
  option log_level 'warning'
  option mode 'rule'
  option match_process 'off'
  option ipv6 '0'
  option allow_lan '0'
  option mixed_port '18132'
  option api_listen '127.0.0.1:18133'
  option authentication '0'
  option tun_enabled '0'
  option dns_enabled '0'
  option geox_auto_update '0'
EOF
      ucode -S /etc/nikki/ucode/mixin.uc >"$work/nikki-mixin.json" 2>"$work/nikki-generate.log" || { cat "$work/nikki-generate.log" >&2; fail 'nikki 原生混入配置生成失败'; }
      yq -M -p json -o yaml '.rules = ["MATCH,DIRECT"]' "$work/nikki-mixin.json" >"$work/nikki.yaml" || fail 'nikki 配置转换失败'
      mkdir "$work/nikki-run" || fail 'nikki 临时运行目录失败'
      mihomo -t -d "$work/nikki-run" -f "$work/nikki.yaml" >"$work/nikki-check.log" 2>&1 || { cat "$work/nikki-check.log" >&2; fail 'nikki 核心配置校验失败'; }
      mihomo -d "$work/nikki-run" -f "$work/nikki.yaml" >"$work/nikki-run.log" 2>&1 &
      pids="$pids $!"
      wait_http http://127.0.0.1:18130/probe.txt "$work/nikki-response" --proxy http://127.0.0.1:18132
      cmp -s "$work/nikki-response" "$work/www/probe.txt" || fail 'nikki 本机代理响应错误'
      json_add_int generatorExit 0
      json_add_int generatedBytes "$(bytes "$work/nikki.yaml")"
      json_add_int configCheckExit 0
      json_add_int localHttpStatus "$http_status"
      json_add_string localResponseSha256 "$(file_digest "$work/nikki-response")"
      json_add_string rpcJson "$(cat "$work/nikki-rpc.json")"
      ;;
    package-manager|opkg)
      if command -v apk >/dev/null; then backend=apk; else backend=opkg; fi
      if [ -x /usr/libexec/package-manager-call ]; then
        /usr/libexec/package-manager-call list-installed >"$work/package-query" || fail '包管理 LuCI 后端查询失败'
        query_method=package-manager-call
      elif [ "$name" = opkg ] && [ "$backend" = opkg ]; then
        opkg list-installed >"$work/package-query" || fail 'opkg 只读查询失败'
        query_method=opkg-list-installed
      else
        fail '缺少所选包管理界面的实际查询后端'
      fi
      json_add_string backend "$backend"
      json_add_string queryMethod "$query_method"
      json_add_int queryBytes "$(bytes "$work/package-query")"
      json_add_array queriedPackages
      for requested in $PLUGIN_PACKAGES; do
        grep -qF "$requested" "$work/package-query" || fail "包管理查询缺少 $requested"
        json_add_string '' "$requested"
      done
      json_close_array
      ;;
    *) fail "没有 $name 的运行烟测实现" ;;
  esac
  json_close_object
  json_close_object
done
json_close_object
json_add_object theme
if [ "$PLUGIN_THEME" = kucat ]; then
  theme=$(uci -q get luci.main.mediaurlbase) || fail '主题配置不可读'
  json_add_string mediaurlbase "$theme"
fi
json_close_object

stop_processes || fail '测试核心进程未正常退出'
restore_configs || fail '无法恢复插件原配置'
cron_after=$(cron_digest) || fail '无法重新读取 cron'
[ "$cron_after" = "$cron_before" ] || fail '烟测改变了 cron 计划任务'
cleaned=1
json_add_object cleanup
json_add_boolean configurationsRestored 1
json_add_boolean cronUnchanged 1
json_add_boolean processesStopped 1
json_close_object
json_dump
