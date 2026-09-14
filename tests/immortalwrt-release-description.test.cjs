const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, after } = require('node:test');
const { REPORT_NAME } = require('../tools/immortalwrt-verification.cjs');
const { pluginObservation } = require('./fixtures/plugin-observation.cjs');

const repo = path.resolve(__dirname, '..');
const tmp = path.join(repo, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const root = fs.mkdtempSync(path.join(tmp, 'immortalwrt-description-test-'));
let sequence = 0;
after(() => {
  const target = fs.realpathSync(root);
  assert.ok(target.startsWith(fs.realpathSync(tmp) + path.sep));
  fs.rmSync(target, { recursive: true });
});

function fixture({ config = 'x86_64', address = '192.168.6.2', mask = '255.255.255.0', gateway = '192.168.6.1' } = {}) {
  const dir = path.join(root, String(++sequence));
  const firmware = path.join(dir, 'firmware');
  fs.mkdirSync(firmware, { recursive: true });
  const diy = path.join(dir, 'diy2-part.sh');
  fs.writeFileSync(diy, [
    '#!/bin/bash',
    `export Ipv4_ipaddr="${address}"`,
    `export Netmask_netm="${mask}"`,
    `export Gateway_Settings="${gateway}"`,
    '',
  ].join('\n'));
  const manifest = path.join(firmware, 'immortalwrt-x86-64-generic.manifest');
  fs.writeFileSync(manifest, [
    'luci-app-autoreboot - 1.0-r1',
    'libc - 1.2.5-r4',
    'luci-i18n-kucat-config-zh-cn - 26.071.56569',
    'luci-theme-kucat - 3.3.2-r20260329',
    'luci-app-kucat-config - 2.2.1-r20260312',
    'luci-app-autoupdate - 26.156.451',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.config'), 'CONFIG_PACKAGE_luci-app-unbuilt=y\n');
  const actualAddress = address === '0' ? '192.168.1.1' : address;
  const actualPrefix = mask === '255.255.254.0' ? 23 : 24;
  const actualGateway = gateway === '0' ? null : gateway;
  const installed = ['luci-app-autoreboot', 'libc', 'luci-i18n-kucat-config-zh-cn', 'luci-theme-kucat', 'luci-app-kucat-config', 'luci-app-autoupdate'];
  const report = path.join(dir, REPORT_NAME);
  fs.writeFileSync(report, JSON.stringify({ schema: 1, config, verifiedAt: '2026-09-12T16:37:56.000Z', images: ['legacy', 'uefi'].map(boot => {
    const file = 'immortalwrt-x86-64-generic-squashfs-combined' + (boot === 'uefi' ? '-efi' : '') + '.img.gz';
    const contents = Buffer.from('fixture-image-' + boot);
    fs.writeFileSync(path.join(firmware, file), contents);
    return { boot, file, sha256: crypto.createHash('sha256').update(contents).digest('hex'), observed: {
      board: { kernel: '6.12.103', release: { target: 'x86/64', version: '25.12-SNAPSHOT' } },
      lan: { up: true, proto: 'static', l3_device: 'eth0', 'ipv4-address': [{ address: actualAddress, mask: actualPrefix }],
        route: actualGateway ? [{ target: '0.0.0.0', mask: 0, nexthop: actualGateway }] : [], 'dns-server': [] },
      uci: { address: actualAddress, gateway: actualGateway, device: 'eth0', dhcpIgnore: '1', theme: '/luci-static/kucat' },
      bridges: [], links: [], startupComplete: true, firewallLanNetworks: ['lan'], packages: installed, efi: boot === 'uefi',
      services: { dnsmasq: { instances: { main: { running: true } } }, uhttpd: { instances: { main: { running: true } } } },
      luci: { status: 403, loginForm: true, themeAsset: true },
      pluginRuntime: pluginObservation(installed),
    } };
  }) }));
  return { dir, diy, manifest, report, env: { CONFIG_FILE: config, TARGET_BOARD: 'x86',
    FIRMWARE_PATH: firmware, DIY_PT2_SH: diy, IMMORTALWRT_RUNTIME_REPORT: report } };
}

function describe(f) {
  const implementation = require('../tools/immortalwrt-release.cjs');
  assert.equal(typeof implementation.describe, 'function', '缺少发布说明生成器');
  return implementation.describe({ env: f.env, now: new Date('2026-09-12T16:37:56Z') });
}

test('发布说明只列出实际清单中的 LuCI 插件和主题，排除未编入的软件及语言依赖', async () => {
  const f = fixture();
  const before = fs.readFileSync(f.manifest);
  const result = await describe(f);
  assert.match(result.body, /2026年09月13日 00:37:56（北京时间）/);
  for (const name of ['luci-app-autoupdate', 'luci-app-kucat-config', 'luci-app-autoreboot', 'luci-theme-kucat']) {
    assert.ok(result.body.includes('`' + name + '`'), '漏掉实际安装的软件: ' + name);
  }
  assert.ok(!result.body.includes('luci-app-unbuilt'));
  assert.ok(!result.body.includes('luci-i18n-'));
  assert.ok(!result.body.includes('`libc`'));
  assert.ok(result.body.indexOf('`luci-app-autoreboot`') < result.body.indexOf('`luci-app-autoupdate`'));
  assert.deepEqual(fs.readFileSync(f.manifest), before, '说明生成不能改写原始清单');
});

test('两配置的发布标题和说明使用本次有效网络设置，子网掩码不会固定为 /24', async () => {
  const cases = [
    { config: 'x86_64', address: '192.168.6.2', mask: '255.255.255.0', gateway: '192.168.6.1', subnet: '192.168.6.0/24' },
    { config: 'x86_64_250', address: '192.168.250.2', mask: '255.255.255.0', gateway: '192.168.250.1', subnet: '192.168.250.0/24' },
    { config: 'x86_64', address: '192.168.7.2', mask: '255.255.254.0', gateway: '192.168.6.1', subnet: '192.168.6.0/23' },
  ];
  for (const expected of cases) {
    const result = await describe(fixture(expected));
    assert.ok(result.name.includes(expected.config));
    assert.ok(result.name.includes(expected.subnet));
    for (const value of [expected.config, expected.address, expected.gateway, expected.subnet]) {
      assert.ok(result.body.includes('`' + value + '`'), '网络信息不符: ' + value);
    }
  }
});

test('清单缺失或包含多个设备时拒绝生成可能错误的插件说明', async () => {
  const missing = fixture();
  fs.renameSync(missing.manifest, path.join(missing.dir, 'saved.manifest'));
  await assert.rejects(() => describe(missing), /清单|manifest/);
  const multiple = fixture();
  fs.copyFileSync(multiple.manifest, path.join(multiple.env.FIRMWARE_PATH, 'another-device.manifest'));
  await assert.rejects(() => describe(multiple), /清单|manifest/);
});

test('清单格式错误和无效网络参数明确失败', async () => {
  const malformed = fixture();
  fs.appendFileSync(malformed.manifest, 'luci-app-imaginary\n');
  await assert.rejects(() => describe(malformed), /清单|manifest/);
  await assert.rejects(() => describe(fixture({ address: '192.168.999.2' })), /IPv4|地址/);
  await assert.rejects(() => describe(fixture({ mask: '255.0.255.0' })), /掩码/);
});

test('未自定义网络或没有 LuCI 插件时如实标明，不编造默认值', async () => {
  const f = fixture({ address: '0', mask: '0', gateway: '0' });
  f.env.TARGET_BOARD = 'armsr';
  fs.writeFileSync(f.manifest, 'libc - 1.2.5-r4\n');
  const result = await describe(f);
  assert.match(result.body, /源码默认/);
  assert.ok(!result.body.includes('192.168.'));
  assert.match(result.body, /未编入 LuCI 插件/);
  const partialFixture = fixture({ mask: '0' });
  partialFixture.env.TARGET_BOARD = 'armsr';
  const partial = await describe(partialFixture);
  assert.match(partial.body, /源码默认掩码.*网段未确定/);
  assert.ok(partial.body.includes('| 默认管理地址 | `192.168.6.2` |'));
});

test('x86 没有实际固件验收结果时不得生成可发布说明', async () => {
  const f = fixture();
  fs.renameSync(f.report, path.join(f.dir, 'saved-report.json'));
  await assert.rejects(() => describe(f), /验收|验证/);
});

test('双引导中的任一镜像缺少插件运行验收时拒绝发布', async () => {
  for (const boot of ['legacy', 'uefi']) {
    const f = fixture();
    const report = JSON.parse(fs.readFileSync(f.report, 'utf8'));
    delete report.images.find(image => image.boot === boot).observed.pluginRuntime;
    fs.writeFileSync(f.report, JSON.stringify(report));
    await assert.rejects(() => describe(f), /插件.*(?:验收|运行|报告)/);
  }
});

test('验收后镜像改变或报告仍缺少网关时拒绝发布说明', async () => {
  const changed = fixture();
  const changedReport = JSON.parse(fs.readFileSync(changed.report, 'utf8'));
  fs.appendFileSync(path.join(changed.env.FIRMWARE_PATH, changedReport.images[0].file), 'changed');
  await assert.rejects(() => describe(changed), /镜像已变化/);
  const invalid = fixture();
  const report = JSON.parse(fs.readFileSync(invalid.report, 'utf8'));
  report.passed = true;
  report.images[0].observed.uci.gateway = null;
  fs.writeFileSync(invalid.report, JSON.stringify(report));
  await assert.rejects(() => describe(invalid), /网关/);
});

test('x86 的源码默认网络也展示实际验收值', async () => {
  const result = await describe(fixture({ address: '0', mask: '0', gateway: '0' }));
  assert.ok(result.name.includes('192.168.1.0/24'));
  assert.ok(result.body.includes('`192.168.1.1`'));
});

test('失败或尚未完成的验收报告即使已有两份观测也不能用于发布', async () => {
  for (const change of [
    report => { report.failure = { message: '保存完整验收报告失败' }; },
    report => { report.failure = null; },
    report => { delete report.verifiedAt; },
    report => { report.verifiedAt = null; },
    report => { report.verifiedAt = 'not-a-date'; },
  ]) {
    const f = fixture();
    const report = JSON.parse(fs.readFileSync(f.report, 'utf8'));
    change(report);
    fs.writeFileSync(f.report, JSON.stringify(report));
    await assert.rejects(() => describe(f), /验收.*(?:失败|完成|时间)/);
  }
});

test('验收报告从固件目录之外读取，避免被上游固件整理改写', async () => {
  const f = fixture();
  const report = f.report;
  assert.equal(path.dirname(report), f.dir);
  assert.ok(!fs.readdirSync(f.env.FIRMWARE_PATH).includes(REPORT_NAME));
  const original = fs.readFileSync(report);
  const result = await describe(f);
  assert.ok(result.body.includes('192.168.6.2'));
  assert.deepEqual(fs.readFileSync(report), original);
});
