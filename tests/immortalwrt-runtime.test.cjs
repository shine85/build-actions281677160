const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pluginObservation } = require('./fixtures/plugin-observation.cjs');

const expected = { address: '192.168.250.2', netmask: '255.255.255.0', prefix: 24,
  gateway: '192.168.250.1', dns: ['223.5.5.5'], disableDhcp: true, disableBridge: true };
const packages = ['luci-app-kucat-config', 'luci-theme-kucat', 'luci-i18n-kucat-config-zh-cn'];
function observation() {
  return {
    board: { kernel: '6.12.103', release: { version: '25.12-SNAPSHOT', target: 'x86/64' } },
    uci: { address: '192.168.250.2/24', netmask: null, gateway: '192.168.250.1', dns: '223.5.5.5',
      device: 'eth0', dhcpIgnore: '1', theme: '/luci-static/kucat' },
    lan: { up: true, l3_device: 'eth0', proto: 'static', 'ipv4-address': [{ address: '192.168.250.2', mask: 24 }],
      route: [{ target: '0.0.0.0', mask: 0, nexthop: '192.168.250.1' }], 'dns-server': ['223.5.5.5'] },
    bridges: [], links: [], startupComplete: true, firewallLanNetworks: ['lan'], packages, efi: false,
    services: { dnsmasq: { instances: { main: { running: true } } }, uhttpd: { instances: { main: { running: true } } } },
    luci: { status: 403, loginForm: true, themeAsset: true },
    pluginRuntime: pluginObservation(packages),
  };
}
function validate(value) { return require('../tools/immortalwrt-verification.cjs').validateObservation(value, expected, packages); }

test('运行验收按实际接口、路由和服务状态生成网络信息', () => {
  const network = validate(observation());
  assert.equal(network.address, '192.168.250.2');
  assert.equal(network.gateway, '192.168.250.1');
  assert.equal(network.subnet, '192.168.250.0/24');
});

test('即使报告自称通过，缺少实际网关也必须拒绝', () => {
  const value = observation();
  value.passed = true;
  value.uci.gateway = null;
  value.lan.route = [];
  assert.throws(() => validate(value), /网关|路由/);
});

test('仅写入配置但运行接口没有应用地址必须拒绝', () => {
  const value = observation();
  value.lan['ipv4-address'] = [{ address: '192.168.6.2', mask: 24 }];
  assert.throws(() => validate(value), /地址/);
});

test('实际 LAN 仍桥接或者 DHCP 未关闭时必须拒绝', () => {
  const bridge = observation();
  bridge.uci.device = 'br-lan';
  bridge.lan.l3_device = 'br-lan';
  bridge.bridges = ['br-lan'];
  assert.throws(() => validate(bridge), /桥接/);
  const dhcp = observation();
  dhcp.uci.dhcpIgnore = null;
  assert.throws(() => validate(dhcp), /DHCP/);
});

test('插件清单不一致或 LuCI 页面不可用不能通过运行验收', () => {
  const missing = observation();
  missing.packages = missing.packages.filter(name => name !== 'luci-theme-kucat');
  assert.throws(() => validate(missing), /kucat|插件|清单/);
  const broken = observation();
  broken.luci = { status: 500, loginForm: false, themeAsset: false };
  assert.throws(() => validate(broken), /LuCI|主题/);
});

test('网络、清单与登录页正常仍不能替代插件的实际运行证据', () => {
  const missing = observation();
  delete missing.pluginRuntime;
  assert.throws(() => validate(missing), /插件.*(?:验收|运行|报告)/);
  const failed = observation();
  failed.pluginRuntime.plugins['luci-app-kucat-config'].runtime.applied.mode = 'light';
  assert.throws(() => validate(failed), /kucat.*运行/);
});

test('首次启动脚本未成功消费时，即使 IPv4 和 LuCI 正常也必须拒绝', () => {
  const value = observation();
  value.startupComplete = false;
  assert.throws(() => validate(value), /首次启动/);
});

test('LAN 通过 VLAN 等下层设备连接桥时不能声称已去桥接', () => {
  const value = observation();
  value.uci.device = value.lan.l3_device = 'lan-vlan';
  value.bridges = ['br-lan'];
  value.links = [{ device: 'lan-vlan', lower: 'br-lan' }];
  assert.throws(() => validate(value), /桥接/);
});

test('LAN 物理接口仍是其他桥的成员时必须拒绝', () => {
  const value = observation();
  value.bridges = ['br-other'];
  value.links = [{ device: 'br-other', lower: 'eth0' }];
  assert.throws(() => validate(value), /桥接/);
});

test('其他 VLAN 上的桥不会被误判成未打标签 LAN 的桥', () => {
  const value = observation();
  value.bridges = ['br-other'];
  value.links = [{ device: 'br-other', lower: 'eth0.10' }, { device: 'eth0.10', lower: 'eth0' }];
  assert.equal(validate(value).device, 'eth0');
});

test('已启用的 IPv6 LAN 必须完成接口和防火墙设置', () => {
  const value = observation();
  Object.assign(value.uci, { delegate: '0', ipv6Proto: 'dhcpv6', ipv6Device: '@lan', reqaddress: 'try', reqprefix: 'auto', filterAaaa: '0' });
  value.firewallLanNetworks.push('ipv6');
  const settings = { ...expected, ipv6Mode: 'relay' };
  const { validateObservation } = require('../tools/immortalwrt-verification.cjs');
  assert.equal(validateObservation(value, settings, packages).address, expected.address);
  const failedInterface = structuredClone(value);
  failedInterface.uci.ipv6Proto = null;
  assert.throws(() => validateObservation(failedInterface, settings, packages), /IPv6/);
  const failedFirewall = structuredClone(value);
  failedFirewall.firewallLanNetworks = ['lan'];
  assert.throws(() => validateObservation(failedFirewall, settings, packages), /IPv6|防火墙/);
});
