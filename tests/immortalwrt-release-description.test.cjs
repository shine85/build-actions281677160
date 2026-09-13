const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, after } = require('node:test');

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
    'luci-app-ttyd - 1.0-r1',
    'libc - 1.2.5-r4',
    'luci-i18n-kucat-config-zh-cn - 26.071.56569',
    'luci-theme-kucat - 3.3.2-r20260329',
    'luci-app-kucat-config - 2.2.1-r20260312',
    'luci-app-autoupdate - 26.156.451',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.config'), 'CONFIG_PACKAGE_luci-app-unbuilt=y\n');
  return { dir, diy, manifest, env: { CONFIG_FILE: config, TARGET_BOARD: 'x86',
    FIRMWARE_PATH: firmware, DIY_PT2_SH: diy } };
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
  for (const name of ['luci-app-autoupdate', 'luci-app-kucat-config', 'luci-app-ttyd', 'luci-theme-kucat']) {
    assert.ok(result.body.includes('`' + name + '`'), '漏掉实际安装的软件: ' + name);
  }
  assert.ok(!result.body.includes('luci-app-unbuilt'));
  assert.ok(!result.body.includes('luci-i18n-'));
  assert.ok(!result.body.includes('`libc`'));
  assert.ok(result.body.indexOf('`luci-app-autoupdate`') < result.body.indexOf('`luci-app-ttyd`'));
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
  fs.writeFileSync(f.manifest, 'libc - 1.2.5-r4\n');
  const result = await describe(f);
  assert.match(result.body, /源码默认/);
  assert.ok(!result.body.includes('192.168.'));
  assert.match(result.body, /未编入 LuCI 插件/);
  const partial = await describe(fixture({ mask: '0' }));
  assert.match(partial.body, /源码默认掩码.*网段未确定/);
  assert.ok(partial.body.includes('| 默认管理地址 | `192.168.6.2` |'));
});
