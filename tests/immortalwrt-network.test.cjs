const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');

const repo = path.resolve(__dirname, '..');
const tmp = path.join(repo, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const suite = fs.mkdtempSync(path.join(tmp, 'immortalwrt-network-test-'));
let sequence = 0;
const unix = value => value.replaceAll('\\', '/');

after(() => {
  const target = fs.realpathSync(suite);
  assert.ok(target.startsWith(fs.realpathSync(tmp) + path.sep));
  fs.rmSync(target, { recursive: true });
});

function execute(script, env) {
  return spawnSync('bash', ['-s'], {
    input: 'export PATH="/usr/bin:/bin:$PATH"\n' + script,
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
}

function fixture({ source, address = '192.168.250.2' } = {}) {
  const directory = path.join(suite, String(++sequence));
  const common = path.join(directory, 'common');
  const home = path.join(directory, 'openwrt');
  fs.mkdirSync(path.join(common, 'custom'), { recursive: true });
  fs.mkdirSync(path.join(common, 'auto-scripts/files'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const name of ['common.sh', 'upgrade.sh']) fs.copyFileSync(path.join(__dirname, 'fixtures/common', name), path.join(common, name));
  fs.copyFileSync(path.join(__dirname, 'fixtures/common/ubuntu.sh'), path.join(common, 'custom/ubuntu.sh'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/common/99-first-run'), path.join(common, 'auto-scripts/files/99-first-run'));
  const generator = path.join(home, 'config_generate');
  fs.writeFileSync(generator, source ?? fs.readFileSync(path.join(__dirname, 'fixtures/network/config_generate-25.12.sh')));
  const diy = path.join(directory, 'diy.sh');
  const values = { Ipv4_ipaddr: address, Netmask_netm: '255.255.255.0', Gateway_Settings: '192.168.250.1',
    DNS_Settings: '223.5.5.5', Broadcast_Ipv4: '0', Disable_DHCP: '1', Disable_Bridge: '1', Ttyd_account_free_login: '1',
    Op_name: '0', Default_theme: '0', Mandatory_theme: '0', Customized_Information: '0', Kernel_partition_size: '0', Rootfs_partition_size: '0' };
  fs.writeFileSync(diy, Object.entries(values).map(([key, value]) => 'export ' + key + '="' + value + '"').join('\n') + '\n');
  const defaults = path.join(home, '99-first-run');
  fs.writeFileSync(defaults, '#!/bin/sh\n');
  fs.writeFileSync(path.join(home, '.config'), '');
  const env = { LINSHI_COMMON: unix(common), HOME_PATH: unix(home), GITHUB_WORKSPACE: unix(repo),
    KEEP_RELEASES: '30', KEEP_WORKFLOWS: '30', GENE_PATH: unix(generator), DIY_PT2_SH: unix(diy), DEFAULT_PATH: unix(defaults),
    SOURCE_CODE: 'IMMORTALWRT', REPO_BRANCH: 'openwrt-25.12', CONFIG_FILE: 'x86_64_250' };
  const prepared = execute('bash tools/prepare-immortalwrt.sh\n', env);
  assert.ifError(prepared.error);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  return { directory, common, generator, env };
}

function configure(f) {
  const common = fs.readFileSync(path.join(f.common, 'common.sh'), 'utf8');
  const start = common.indexOf('function Diy_definition() {');
  const end = common.indexOf('if [[ "${Password_free_login}"', start);
  assert.ok(start >= 0 && end > start);
  return execute('TIME() { printf "%s\\n" "$*"; }\n' + common.slice(start, end) + '\n}\nDiy_definition\n', f.env);
}

test('未知网络生成布局必须中止，不能零修改却继续编译', () => {
  const f = fixture({ source: '#!/bin/sh\necho changed-upstream-layout\n' });
  const before = fs.readFileSync(f.generator);
  const result = configure(f);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, '缺少兼容插入位置时仍返回成功\n' + result.stdout);
  assert.deepEqual(fs.readFileSync(f.generator), before);
});

test('网络插入位置重复时拒绝猜测并保持原生成器', () => {
  const original = fs.readFileSync(path.join(__dirname, 'fixtures/network/config_generate-25.12.sh'), 'utf8');
  const f = fixture({ source: original + '\nfor key in $keys; do generate_switch $key; done\n' });
  const before = fs.readFileSync(f.generator);
  const result = configure(f);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, '重复位置被当成可用生成器');
  assert.deepEqual(fs.readFileSync(f.generator), before);
});

test('无效 IPv4 参数在改写生成器之前明确失败', () => {
  const f = fixture({ address: '192.168.999.2' });
  const before = fs.readFileSync(f.generator);
  const result = configure(f);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, '错误 IPv4 被静默接受');
  assert.deepEqual(fs.readFileSync(f.generator), before);
});

test('Windows CRLF 的有效 DIY 配置与 Linux 输入具有相同含义', () => {
  const { readSettings } = require('../tools/immortalwrt-network.cjs');
  const settings = readSettings([
    'export Ipv4_ipaddr="192.168.6.2"',
    'export Netmask_netm="255.255.255.0"',
    'export Gateway_Settings="192.168.6.1"',
    'export DNS_Settings="223.5.5.5 1.1.1.1"',
    '',
  ].join('\r\n'));
  assert.equal(settings.address, '192.168.6.2');
  assert.equal(settings.prefix, 24);
  assert.deepEqual(settings.dns, ['223.5.5.5', '1.1.1.1']);
});

test('合法单引号和无引号网络赋值不能被当作未启用', () => {
  const { readSettings } = require('../tools/immortalwrt-network.cjs');
  const input = fs.readFileSync(path.join(repo, 'build/Immortalwrt/diy-part-250.sh'), 'utf8')
    .replace('export Disable_DHCP="1"', "export Disable_DHCP='1'")
    .replace('export DNS_Settings="223.5.5.5"', 'export DNS_Settings=223.5.5.5');
  const settings = readSettings(input);
  assert.equal(settings.disableDhcp, true);
  assert.deepEqual(settings.dns, ['223.5.5.5']);
});

test('重复或非独立网络声明必须明确拒绝', () => {
  const { readSettings } = require('../tools/immortalwrt-network.cjs');
  const input = fs.readFileSync(path.join(repo, 'build/Immortalwrt/diy-part-250.sh'), 'utf8');
  assert.throws(() => readSettings(input + '\nDisable_Bridge=0\n'), /唯一|重复/);
  assert.throws(() => readSettings(input.replace('export Disable_DHCP="1"', 'if true; then export Disable_DHCP=1; fi')), /赋值|读取/);
});

test('插入点移出首次生成 network 的分支时必须拒绝', () => {
  const original = fs.readFileSync(path.join(__dirname, 'fixtures/network/config_generate-25.12.sh'), 'utf8');
  const moved = original.replace('\tfor key in $keys; do generate_switch $key; done\nfi', 'fi\nfor key in $keys; do generate_switch $key; done');
  assert.notEqual(moved, original);
  const f = fixture({ source: moved });
  const before = fs.readFileSync(f.generator);
  const result = configure(f);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, '网络设置调用被写到已有配置保护分支之外');
  assert.deepEqual(fs.readFileSync(f.generator), before);
});

test('23.05、24.10、25.12 的实际上游生成器均接受两份现有配置', () => {
  const implementation = require('../tools/immortalwrt-network.cjs');
  const helper = fs.readFileSync(path.join(repo, 'tools/immortalwrt-lan-defaults.sh'), 'utf8');
  for (const version of ['23.05', '24.10', '25.12']) {
    const source = fs.readFileSync(path.join(__dirname, 'fixtures/network/config_generate-' + version + '.sh'), 'utf8');
    for (const name of ['diy-part.sh', 'diy-part-250.sh']) {
      const settings = implementation.readSettings(fs.readFileSync(path.join(repo, 'build/Immortalwrt', name), 'utf8'));
      const generated = implementation.configure(source, settings, helper);
      const parsed = execute('sh -n <<\'GENERATOR\'\n' + generated + '\nGENERATOR\n', {});
      assert.equal(parsed.status, 0, version + '/' + name + ': ' + parsed.stderr);
      assert.ok(generated.includes('ipad=${ipaddr:-"' + settings.address + '"}'));
      assert.equal((generated.match(/^\s*immortalwrt_apply_lan_defaults .*\|\| exit 1$/gm) || []).length, 1);
    }
  }
});
