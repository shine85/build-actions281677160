const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIPv4 } = require('node:net');
const { KUCAT_PACKAGES: criticalPackages } = require('./immortalwrt-plugins.cjs');
const { validatePluginResults } = require('./immortalwrt-plugin-runtime.cjs');

const REPORT_NAME = 'immortalwrt-runtime-verification.json';
const fail = message => { throw new Error('固件运行验收失败: ' + message); };
const sameValues = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const PACKAGE_LINE = /^([A-Za-z0-9][A-Za-z0-9+_.-]*) - \S.*$/;

function parseFirmwareManifest(text) {
  const packages = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(PACKAGE_LINE);
    if (!match) throw new Error('固件 manifest 格式错误');
    packages.push(match[1]);
  }
  if (!packages.length) throw new Error('固件 manifest 清单为空');
  return packages;
}

function validateObservation(observed, expected, manifestPackages) {
  if (observed?.board?.release?.target !== 'x86/64' || !observed.board.kernel) fail('缺少实际启动的系统信息');
  if (observed.startupComplete !== true) fail('首次启动脚本尚未成功执行');
  if (expected.sourceVersion && /^\d+\.\d+$/.test(expected.sourceVersion) &&
      !new RegExp('^' + expected.sourceVersion.replace('.', '\\.') + '(?:$|[.-])').test(observed.board.release.version)) fail('实际源码版本与编译选择不符');
  if (!observed?.lan?.up || observed.lan.proto !== 'static') fail('LAN 接口没有正常启动');
  const addresses = observed.lan['ipv4-address'];
  if (!Array.isArray(addresses) || addresses.length !== 1 || !isIPv4(addresses[0].address)) fail('实际 LAN 地址缺失或不唯一');
  const { address, mask: prefix } = addresses[0];
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) fail('实际子网前缀无效');
  if (expected.address !== '0' && address !== expected.address) fail('实际 LAN 地址与编译配置不符');
  if (expected.prefix !== null && prefix !== expected.prefix) fail('实际子网掩码与编译配置不符');
  const uci = observed.uci || {};
  if (!uci.device || !observed.lan.l3_device) fail('缺少实际 LAN 设备');
  if (expected.gateway !== '0') {
    if (uci.gateway !== expected.gateway) fail('实际默认网关与编译配置不符');
    if (!observed.lan.route?.some(route => route.target === '0.0.0.0' && route.mask === 0 && route.nexthop === expected.gateway)) fail('默认网关未形成生效路由');
  }
  if (expected.dns.length && (!sameValues((uci.dns || '').split(/\s+/).filter(Boolean), expected.dns) ||
      !sameValues(observed.lan['dns-server'] || [], expected.dns))) fail('DNS 没有按编译配置生效');
  if (expected.disableDhcp && uci.dhcpIgnore !== '1') fail('LAN DHCP 未关闭');
  if (!Array.isArray(observed.bridges) || !Array.isArray(observed.links) ||
      observed.links.some(link => !link || typeof link.device !== 'string' || typeof link.lower !== 'string')) fail('缺少实际设备和桥接状态');
  const bridged = new Set(observed.bridges);
  for (const { device, lower } of observed.links) {
    if (observed.bridges.includes(device)) bridged.add(lower);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const { device, lower } of observed.links) {
      if (bridged.has(lower) && !bridged.has(device)) { bridged.add(device); expanded = true; }
    }
  }
  if (expected.disableBridge && (bridged.has(observed.lan.l3_device) ||
      bridged.has(uci.device) || observed.lan.l3_device !== uci.device)) fail('LAN 去桥接没有生效');
  if (expected.ipv6Mode === 'router' && (uci.ip6assign !== '64' || uci.ra !== 'server' || uci.dhcpv6 !== 'server')) fail('IPv6 路由模式配置未完成');
  if (['relay', 'disabled'].includes(expected.ipv6Mode)) {
    if (uci.delegate !== '0' || ['ip6assign', 'ra', 'raManagement', 'raDefault', 'dhcpv6', 'ndp'].some(key => uci[key] != null)) fail('IPv6 LAN 清理未完成');
    if (uci.filterAaaa !== (expected.ipv6Mode === 'relay' ? '0' : '1')) fail('IPv6 DNS 设置未生效');
  }
  if (expected.ipv6Mode === 'relay' && (uci.ipv6Proto !== 'dhcpv6' || uci.ipv6Device !== '@lan' ||
      uci.reqaddress !== 'try' || uci.reqprefix !== 'auto' || !observed.firewallLanNetworks?.includes('ipv6'))) fail('IPv6 LAN 接口或防火墙设置未完成');
  if (expected.ipv6Mode === 'disabled' && (uci.ulaPrefix != null || uci.wan6 != null)) fail('IPv4 模式仍保留 IPv6 网络配置');
  if (!Array.isArray(observed.packages) || criticalPackages.some(name => !observed.packages.includes(name))) fail('kucat 必需插件缺失');
  const luciPackages = list => list.filter(name => /^luci-(app|theme)-/.test(name));
  if (!sameValues(luciPackages(observed.packages), luciPackages(manifestPackages))) fail('实际插件清单与固件 manifest 不一致');
  for (const service of ['dnsmasq', 'uhttpd']) {
    if (!Object.values(observed.services?.[service]?.instances || {}).some(instance => instance.running === true)) fail(service + ' 服务没有运行');
  }
  if (uci.theme !== '/luci-static/kucat' || !observed.luci?.themeAsset) fail('默认 kucat 主题未生效');
  if (![200, 403].includes(observed.luci.status) || !observed.luci.loginForm) fail('LuCI 登录页面不可用');
  validatePluginResults(observed.pluginRuntime, observed.packages);
  const ip = address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const subnet = [24, 16, 8, 0].map(shift => (network >>> shift) & 255).join('.') + '/' + prefix;
  return { address, prefix, subnet, gateway: uci.gateway || '0', dns: observed.lan['dns-server'] || [], device: uci.device };
}

async function sha256(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function readVerifiedNetwork({ directory, reportPath, config, settings, packages }) {
  if (!reportPath) fail('缺少实际固件验收报告路径');
  let report;
  try { report = JSON.parse(await fs.promises.readFile(reportPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') fail('缺少实际固件验收报告');
    throw error;
  }
  if (!report || report.config !== config || report.schema !== 1 || !Array.isArray(report.images) || report.images.length !== 2) fail('验收报告的配置或格式不匹配');
  if (Object.hasOwn(report, 'failure')) fail('验收报告记录了失败');
  if (typeof report.verifiedAt !== 'string' || !Number.isFinite(Date.parse(report.verifiedAt))) fail('验收报告缺少有效的完成时间');
  const types = new Set();
  let network;
  for (const image of report.images) {
    if (!['legacy', 'uefi'].includes(image.boot) || types.has(image.boot)) fail('引导类型验收不完整');
    types.add(image.boot);
    if (path.basename(image.file) !== image.file || !/squashfs-combined(?:-efi)?\.img\.gz$/.test(image.file)) fail('验收镜像名称无效');
    if (image.file.includes('-combined-efi.') !== (image.boot === 'uefi')) fail('验收镜像与引导类型不匹配');
    if (await sha256(path.join(directory, image.file)) !== image.sha256) fail('验收报告对应的镜像已变化');
    if (image.observed?.efi !== (image.boot === 'uefi')) fail('实际引导方式与镜像不符');
    const current = validateObservation(image.observed, settings, packages);
    if (network && JSON.stringify(current) !== JSON.stringify(network)) fail('两种引导的实际网络配置不同');
    network = current;
  }
  return network;
}

module.exports = { REPORT_NAME, parseFirmwareManifest, validateObservation, readVerifiedNetwork, sha256 };
