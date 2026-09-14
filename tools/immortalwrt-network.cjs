const fs = require('node:fs');
const path = require('node:path');
const { isIPv4, isIP } = require('node:net');

function readSettings(diy) {
  const code = diy.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/#.*$/, '')).join('\n');
  function value(name, optional = false) {
    const declarations = [...code.matchAll(new RegExp('(?:^|[^a-zA-Z0-9_])' + name + '\\s*=', 'g'))];
    // 旧 DIY 没有某个可选开关时，沿用 common 的未启用语义。
    if (!declarations.length && optional) return '0';
    if (declarations.length !== 1) throw new Error('无法唯一读取网络设置: ' + name);
    const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}=(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s;'"]+))[ \\t]*$`, 'm');
    const match = code.match(pattern);
    const result = match && (match[1] ?? match[2] ?? match[3]);
    if (!result) throw new Error('网络设置必须使用独立字面量赋值: ' + name);
    return result;
  }
  function ipv4(name, optional = false) {
    const result = value(name, optional);
    if (result !== '0' && !isIPv4(result)) throw new Error('无效 IPv4 设置: ' + name);
    return result;
  }
  function enabled(name) {
    const result = value(name, true);
    if (!['0', '1'].includes(result)) throw new Error('网络开关只能为 0 或 1: ' + name);
    return result === '1';
  }
  const address = ipv4('Ipv4_ipaddr');
  const netmask = ipv4('Netmask_netm');
  const gateway = ipv4('Gateway_Settings');
  const bits = netmask === '0' ? null : netmask.split('.').map(n => Number(n).toString(2).padStart(8, '0')).join('');
  if (bits && !/^1*0*$/.test(bits)) throw new Error('IPv4 子网掩码不连续');
  const prefix = bits === null ? null : bits.replace(/0/g, '').length;
  const dnsValue = value('DNS_Settings', true);
  const dns = dnsValue === '0' ? [] : dnsValue.trim().split(/\s+/);
  if (dns.some(item => !isIP(item))) throw new Error('无效 DNS 地址');
  const ipv6 = enabled('Enable_IPV6_function');
  const relay = enabled('Create_Ipv6_Lan');
  const ipv4Only = enabled('Enable_IPV4_function');
  return { address, netmask, prefix, gateway, dns, broadcast: ipv4('Broadcast_Ipv4', true),
    disableDhcp: enabled('Disable_DHCP'), disableBridge: enabled('Disable_Bridge'), ttydAccountFree: enabled('Ttyd_account_free_login'),
    ipv6Mode: ipv6 ? 'router' : relay ? 'relay' : ipv4Only ? 'disabled' : null };
}

function replaceOnce(source, pattern, replacement, name) {
  if ([...source.matchAll(pattern)].length !== 1) throw new Error('网络生成器中的' + name + '缺失或不唯一');
  return source.replace(pattern, replacement);
}

function configure(source, settings, helper) {
  source = source.replace(/\r\n/g, '\n');
  if (!source.startsWith('#!/bin/sh\n')) throw new Error('网络生成器必须使用 /bin/sh');
  if (source.includes('immortalwrt_apply_lan_defaults')) throw new Error('网络生成器已被处理，拒绝重复注入');
  const customDefaults = settings.gateway !== '0' || settings.dns.length || settings.broadcast !== '0' ||
    settings.disableDhcp || settings.disableBridge || settings.ttydAccountFree;
  if (customDefaults) {
    const blocks = [...source.matchAll(/^if \[ ! -s \/etc\/config\/network \]; then\n([\s\S]*?)^fi\n(?=\nif \[ ! -s \/etc\/config\/system \]; then)/gm)];
    if (blocks.length !== 1) throw new Error('首次生成 network 的保护分支结构不匹配');
    const tail = blocks[0][1].match(/^[ \t]*for key in \$keys; do generate_switch \$key; done[ \t]*\n([\s\S]*)$/m);
    if (!tail || tail[1].split('\n').some(line => line.trim() && !line.trim().startsWith('#'))) {
      throw new Error('网络收尾调用位置不在首次生成 network 的分支末尾');
    }
    const quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
    const arguments_ = [settings.gateway, settings.dns.join(' ') || '0', settings.broadcast,
      Number(settings.disableDhcp), Number(settings.disableBridge), Number(settings.ttydAccountFree)].map(quote).join(' ');
    source = replaceOnce(source, /^([ \t]*)for key in \$keys; do generate_switch \$key; done[ \t]*$/gm,
      line => line + '\n\timmortalwrt_apply_lan_defaults ' + arguments_ + ' || exit 1', '收尾调用位置');
    source = source.replace('#!/bin/sh\n', '#!/bin/sh\n\n' + helper.replace(/^#![^\n]*\n/, '').trim() + '\n');
  }
  if (settings.address !== '0') source = replaceOnce(source, /(lan\)\s+ipad=\$\{ipaddr:-")[^"]+("\})/g,
    (_, before, after) => before + settings.address + after, 'LAN 默认地址');
  if (settings.netmask !== '0') source = replaceOnce(source, /(netm=\$\{netmask:-")[^"]+("\})/g,
    (_, before, after) => before + settings.netmask + after, '默认子网掩码');
  return source;
}

function install(generator, diy) {
  const settings = readSettings(fs.readFileSync(diy, 'utf8'));
  const original = fs.readFileSync(generator, 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, 'immortalwrt-lan-defaults.sh'), 'utf8');
  const updated = configure(original, settings, helper);
  fs.writeFileSync(generator, updated, 'utf8');
  return settings;
}

module.exports = { readSettings, configure, install };
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('用法: immortalwrt-network.cjs <config_generate> <diy脚本>');
    install(process.argv[2], process.argv[3]);
    console.log('已写入默认网络生成逻辑，实际生效结果需通过固件验收');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
