const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');

const repo = path.resolve(__dirname, '..');
const tmp = path.join(repo, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const suite = fs.mkdtempSync(path.join(tmp, 'immortalwrt-startup-test-'));
let sequence = 0;
const unix = value => value.replaceAll('\\', '/');
after(() => {
  const target = fs.realpathSync(suite);
  assert.ok(target.startsWith(fs.realpathSync(tmp) + path.sep));
  fs.rmSync(target, { recursive: true });
});

function bash(script, env = {}) {
  const result = spawnSync('bash', ['-s'], { input: 'export PATH="/usr/bin:/bin:$PATH"\n' + script,
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(result.error);
  return result;
}

function fixture() {
  const directory = path.join(suite, String(++sequence));
  const common = path.join(directory, 'common');
  fs.mkdirSync(path.join(common, 'custom'), { recursive: true });
  fs.mkdirSync(path.join(common, 'auto-scripts/files'), { recursive: true });
  for (const file of ['common.sh', 'upgrade.sh']) fs.copyFileSync(path.join(__dirname, 'fixtures/common', file), path.join(common, file));
  fs.copyFileSync(path.join(__dirname, 'fixtures/common/ubuntu.sh'), path.join(common, 'custom/ubuntu.sh'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/common/99-first-run'), path.join(common, 'auto-scripts/files/99-first-run'));
  const prepared = bash('bash tools/prepare-immortalwrt.sh\n', { LINSHI_COMMON: unix(common), KEEP_RELEASES: '30', KEEP_WORKFLOWS: '30' });
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  return { directory, common, startup: fs.readFileSync(path.join(common, 'auto-scripts/files/99-first-run'), 'utf8'),
    source: fs.readFileSync(path.join(common, 'common.sh'), 'utf8') };
}

test('APK 与 opkg 首次启动均删除禁用的源并保留系统源', () => {
  for (const manager of ['apk', 'opkg']) {
    const f = fixture();
    const relative = manager === 'apk' ? 'etc/apk/repositories.d/distfeeds.list' : 'etc/opkg/distfeeds.conf';
    const feeds = path.join(f.directory, relative);
    fs.mkdirSync(path.dirname(feeds), { recursive: true });
    fs.writeFileSync(feeds, 'official/base\nhelloworld\npasswall\nofficial/luci\n');
    const block = f.startup.slice(f.startup.indexOf('# 从 /etc/opkg'), f.startup.indexOf('# 如果存在 /usr/share/ucode'));
    const result = bash(block.replaceAll('/etc/', unix(f.directory) + '/etc/') + '\nexit 0\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(fs.readFileSync(feeds, 'utf8'), 'official/base\nofficial/luci\n');
  }
});

test('存在旧版 LuCI 状态页时正确修改时间，不存在时正常跳过', () => {
  for (const exists of [true, false]) {
    const f = fixture();
    const page = path.join(f.directory, 'usr/lib/lua/luci/view/admin_status/index.htm');
    if (exists) {
      fs.mkdirSync(path.dirname(page), { recursive: true });
      fs.writeFileSync(page, 'localtime = old_time,\n(<%=pcdata(ver.luciversion)%>)\n');
    }
    const block = f.startup.slice(f.startup.indexOf('luci_web='), f.startup.indexOf('# 修改 /etc/profile'));
    const result = bash(block.replaceAll('/usr/', unix(f.directory) + '/usr/') + '\nexit 0\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (exists) {
      const text = fs.readFileSync(page, 'utf8');
      assert.ok(text.includes('os.date("%Y-%m-%d")'));
      assert.ok(!text.includes('old_time'));
    } else assert.ok(!fs.existsSync(page));
  }
});

function networkStartup(f, selection) {
  const start = f.source.indexOf('if [[ "${Enable_IPV6_function}" == "1" ]]; then\n  echo');
  const end = f.source.indexOf('\nif [[ "${Enable_IPV6_function}" == "1" ]]; then', start + 1);
  assert.ok(start >= 0 && end > start);
  const file = path.join(f.directory, 'generated-first-run');
  const generated = bash(f.source.slice(start, end), { Enable_IPV6_function: selection === 'ipv6' ? '1' : '0',
    Create_Ipv6_Lan: selection === 'relay' ? '1' : '0', Enable_IPV4_function: selection === 'ipv4' ? '1' : '0',
    DEFAULT_PATH: unix(file), devicee: '', ifnamee: "uci set network.ipv6.device='@lan'",
    set_add: "uci add_list firewall.@zone[0].network='ipv6'" });
  assert.equal(generated.status, 0, generated.stderr);
  return fs.readFileSync(file, 'utf8');
}

function runStartup(script, { missing = true, fail = '' } = {}) {
  return bash([
    'uci() {',
    '  if [[ "$1" == -q && "$2" == get ]]; then [[ "$TEST_MISSING" == 0 ]]; return; fi',
    '  if [[ "$1" == delete && "$TEST_MISSING" == 1 ]]; then printf "uci: Entry not found\\n" >&2; return 1; fi',
    '  if [[ "$1" == "$TEST_FAIL" ]]; then printf "uci: write failed\\n" >&2; return 42; fi',
    '  printf "%s\\n" "$*"',
    '}',
    script,
    'printf "startup-completed\\n"',
    'exit 0',
  ].join('\n'), { TEST_MISSING: missing ? '1' : '0', TEST_FAIL: fail });
}

test('IPv6 可选键在新旧系统中缺失均可跳过，存在时仍执行清理', () => {
  for (const selection of ['relay', 'ipv4']) {
    const script = networkStartup(fixture(), selection);
    for (const missing of [true, false]) {
      const result = runStartup(script, { missing });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.ok(result.stdout.includes('startup-completed'));
      assert.equal(result.stdout.includes('delete dhcp.lan.ra_management'), !missing);
    }
  }
});

test('首次启动的重要 UCI 设置、删除和提交失败必须传播', () => {
  for (const selection of ['ipv6', 'relay', 'ipv4']) {
    const script = networkStartup(fixture(), selection);
    for (const fail of ['set', 'commit', ...(selection === 'ipv6' ? [] : ['delete'])]) {
      const result = runStartup(script, { missing: false, fail });
      assert.notEqual(result.status, 0, selection + ' ' + fail + ' 失败被掩盖');
      assert.ok(!result.stdout.includes('startup-completed'));
      assert.match(result.stderr, /write failed/);
    }
  }
});
