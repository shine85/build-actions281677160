const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkPlugins, validatePluginResults } = require('../tools/immortalwrt-plugin-runtime.cjs');

const marker = 'immortalwrt-plugin-local-ok\n';
const hash = text => createHash('sha256').update(text).digest('hex');
const names = ['autoreboot', 'autoupdate', 'firewall', 'frpc', 'homeproxy', 'kucat-config', 'nikki', 'package-manager'];
const packages = names.map(name => 'luci-app-' + name).concat('luci-theme-kucat');
const asset = { path: '/luci-static/resources/view/autoreboot.js', status: 200, bytes: 100, sha256: 'a'.repeat(64), syntax: 'valid' };
const view = { kind: 'view', route: '/cgi-bin/luci/admin/system/autoreboot', status: 200, authenticated: true,
  view: 'autoreboot', assets: [asset] };

function observation() {
  const runtime = {
    autoreboot: { shellSyntaxExit: 0, configReadable: true,
      generatedSchedule: '17 3 * * 2 sleep 5 && touch /etc/banner && reboot #autoreboot_smoke', installedSchedule: false },
    autoupdate: { shellSyntaxExit: 0, luaSyntaxExit: 0, configReadable: true, metadataReadable: true },
    firewall: { configCheckExit: 0, generatedBytes: 1500, loadedChains: ['input', 'forward', 'output'] },
    frpc: { coreVersion: '0.64.0', configBytes: 180, configCheckMethod: 'verify', configCheckExit: 0, startupExit: 1,
      startupDiagnostic: 'login to server failed: dial tcp 127.0.0.1:1: connect: connection refused' },
    homeproxy: { generatorExit: 0, generatedBytes: 800, configCheckExit: 0,
      localHttpStatus: 200, localResponseSha256: hash(marker), rpcAvailable: true },
    'kucat-config': { shellSyntaxExit: 0, configReadable: true,
      applied: { mode: 'dark', primary_rgbm: '26,131,97', font_d: '1.3rem' } },
    nikki: { generatorExit: 0, generatedBytes: 900, configCheckExit: 0,
      localHttpStatus: 200, localResponseSha256: hash(marker), rpc: { app: '1.32.4-r1', core: 'v1.19.18' } },
    'package-manager': { backend: 'apk', queryMethod: 'package-manager-call', queryBytes: 5000, queriedPackages: packages },
  };
  const paths = { firewall: 'firewall/zones', homeproxy: 'homeproxy/client', 'kucat-config': 'kucat-config/config', nikki: 'nikki/app' };
  const categories = { firewall: 'network', homeproxy: 'services', frpc: 'services', nikki: 'services' };
  const plugins = Object.fromEntries(names.map(name => {
    const viewName = paths[name] || name;
    return ['luci-app-' + name, { runtime: runtime[name], ui: { ...view,
      route: '/cgi-bin/luci/admin/' + (categories[name] || 'system') + '/' + name,
      view: viewName, assets: [{ ...asset, path: '/luci-static/resources/view/' + viewName + '.js' }] } }];
  }));
  plugins['luci-app-autoupdate'].ui = { kind: 'status', route: '/cgi-bin/luci/admin/system/autoupdate/check_status',
    status: 200, authenticated: true, payload: { running: false, is_upgrading: false, success: false }, mainForm: 'not_tested' };
  return { schema: 1, scope: 'isolated-local-smoke', plugins,
    theme: { name: 'kucat', mediaurlbase: '/luci-static/kucat', htmlUsesTheme: true,
      assets: [{ ...asset, path: '/luci-static/kucat/css/style.css', syntax: undefined }] },
    cleanup: { configurationsRestored: true, cronUnchanged: true, processesStopped: true },
    coverage: { browserInteraction: 'not_tested', externalServices: 'not_tested',
      firmwareUpgrade: 'not_tested', scheduledReboot: 'not_tested', transparentProxy: 'not_tested',
      frpcTunnel: 'not_tested', frpcAdminApi: 'not_tested' } };
}

test('本机功能证据完整时接受八个应用，同时保留未覆盖业务范围', () => {
  assert.equal(validatePluginResults(observation(), packages), true);
});

test('安装、版本号或配置校验不能代替代理与 FRPC 的本机功能证据', () => {
  for (const name of ['homeproxy', 'nikki', 'frpc']) {
    const result = observation();
    result.plugins['luci-app-' + name].runtime = { version: '1.0', installed: true, configCheckExit: 0 };
    assert.throws(() => validatePluginResults(result, packages), new RegExp(name, 'i'));
  }
});

test('缺少所选插件或必要状态时拒绝报告中的自称成功', () => {
  const result = observation();
  result.passed = true;
  delete result.plugins['luci-app-frpc'];
  assert.throws(() => validatePluginResults(result, packages), /frpc/i);
  const dirty = observation();
  dirty.cleanup.cronUnchanged = false;
  assert.throws(() => validatePluginResults(dirty, packages), /cron|计划任务/);
});

test('23.05 实际 opkg 包名与原生只读查询可以完成包管理验收', () => {
  const result = observation();
  const expected = packages.map(name => name === 'luci-app-package-manager' ? 'luci-app-opkg' : name);
  result.plugins['luci-app-opkg'] = result.plugins['luci-app-package-manager'];
  delete result.plugins['luci-app-package-manager'];
  Object.assign(result.plugins['luci-app-opkg'].runtime, { backend: 'opkg', queryMethod: 'opkg-list-installed', queriedPackages: expected });
  assert.equal(validatePluginResults(result, expected), true);
});

test('核心没有 verify 时要求真实启动解析与受控连接失败证据', () => {
  const result = observation();
  Object.assign(result.plugins['luci-app-frpc'].runtime, { configCheckMethod: 'startup-parser', configCheckExit: null });
  assert.equal(validatePluginResults(result, packages), true);
  result.plugins['luci-app-frpc'].runtime.startupDiagnostic = 'configuration file not found';
  assert.throws(() => validatePluginResults(result, packages), /frpc/);
});

test('FRPC 0.51.3 的受控拒连退出 0 可验收且不改写退出码', () => {
  for (const method of ['verify', 'startup-parser']) {
    const result = observation();
    const runtime = result.plugins['luci-app-frpc'].runtime;
    Object.assign(runtime, { coreVersion: '0.51.3', configCheckMethod: method,
      configCheckExit: method === 'verify' ? 0 : null, startupExit: 0 });
    assert.equal(validatePluginResults(result, packages), true);
    assert.equal(runtime.startupExit, 0);
  }
});

test('FRPC 不得把未知版本的退出 0 或任意错误当成受控拒连', () => {
  for (const invalid of [
    { coreVersion: '0.64.0' },
    { coreVersion: undefined },
    { coreVersion: '0.51.3-custom' },
    { startupDiagnostic: '' },
    { startupDiagnostic: 'configuration file not found' },
    { startupDiagnostic: 'dial tcp 127.0.0.1:11: connect: connection refused' },
    { startupDiagnostic: 'dial tcp 192.0.2.1:1: connect: connection refused' },
    { startupExit: 2 },
    { startupExit: 124 },
    { configCheckExit: 1 },
    { configBytes: 0 },
  ]) {
    const result = observation();
    Object.assign(result.plugins['luci-app-frpc'].runtime, { coreVersion: '0.51.3', startupExit: 0 }, invalid);
    assert.throws(() => validatePluginResults(result, packages), /frpc/, JSON.stringify(invalid));
  }
});

test('guest FRPC 分支按已知 CLI 版本处理退出码并保留真实结果', t => {
  const source = fs.readFileSync(path.join(__dirname, '../tools/immortalwrt-plugin-runtime.sh'), 'utf8').replace(/\r\n/g, '\n');
  const probe = source.match(/      frpc --help >[\s\S]*?(?=\n      ;;)/)?.[0];
  assert.ok(probe, '无法定位需要执行的 FRPC CLI 探针');
  const tempRoot = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const work = fs.mkdtempSync(path.join(tempRoot, 'frpc-exit-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(work);
    assert.ok(resolved.startsWith(fs.realpathSync(tempRoot) + path.sep));
    fs.rmSync(resolved, { recursive: true });
  });
  fs.writeFileSync(path.join(work, 'frpc.ini'), '[common]\nserver_addr = 127.0.0.1\nserver_port = 1\nlogin_fail_exit = true\n');
  // 仅替换 guest 核心命令和 jshn 输出接口；执行真实的能力探测、诊断筛选和退出码判断。
  const driver = [
    'work=$PWD',
    'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'bytes() { wc -c < "$1" | tr -d " "; }',
    'json_add_int() { printf "%s=%s\\n" "$1" "$2"; }',
    'json_add_string() { printf "%s=%s\\n" "$1" "$2"; }',
    'json_add_null() { printf "%s=null\\n" "$1"; }',
    'frpc() {',
    '  case "$1" in',
    '    --help) printf "Usage: frpc\\n"; [ "$FRPC_HAS_VERIFY" != 1 ] || printf "  verify  Verify configuration\\n"; return 0 ;;',
    '    -v) printf "%s\\n" "$FRPC_VERSION"; return 0 ;;',
    '    verify) [ "$2" = -c ] && [ "$3" = "$work/frpc.ini" ] || return 99; return "$FRPC_CONFIG_EXIT" ;;',
    '    -c) [ "$2" = "$work/frpc.ini" ] || return 99; printf "%s\\n" "$FRPC_DIAGNOSTIC"; return "$FRPC_STARTUP_EXIT" ;;',
    '    *) return 99 ;;',
    '  esac',
    '}',
    probe,
  ].join('\n');
  const refusal = 'login to server failed: dial tcp 127.0.0.1:1: connect: connection refused';
  for (const scenario of [
    { version: '0.51.3', verify: true, exit: 0, expected: 0 },
    { version: '0.51.3', verify: false, exit: 0, expected: 0 },
    { version: '0.64.0', verify: true, exit: 1, expected: 0 },
    { version: '0.64.0', verify: true, exit: 0, expected: 1 },
    { version: '0.51.3', verify: true, exit: 2, expected: 1 },
    { version: '0.51.3', verify: false, exit: 124, expected: 1 },
    { version: '0.51.3', verify: true, exit: 0, diagnostic: 'configuration file not found', expected: 1 },
    { version: '0.51.3', verify: true, exit: 0, configExit: 1, expected: 1 },
  ]) {
    const result = spawnSync('bash', ['-s'], { cwd: work, input: driver, encoding: 'utf8', timeout: 10000, windowsHide: true,
      env: { ...process.env, FRPC_VERSION: scenario.version, FRPC_HAS_VERIFY: scenario.verify ? '1' : '0',
        FRPC_STARTUP_EXIT: String(scenario.exit), FRPC_CONFIG_EXIT: String(scenario.configExit ?? 0),
        FRPC_DIAGNOSTIC: scenario.diagnostic ?? refusal } });
    if (result.error) throw result.error;
    assert.equal(result.status, scenario.expected, JSON.stringify(scenario) + '\n' + result.stderr);
    if (scenario.expected === 0) {
      const fields = result.stdout.trim().split(/\r?\n/);
      assert.ok(fields.includes('startupExit=' + scenario.exit), result.stdout);
      assert.ok(fields.includes('coreVersion=' + scenario.version), result.stdout);
      assert.ok(fields.includes('configCheckMethod=' + (scenario.verify ? 'verify' : 'startup-parser')), result.stdout);
    }
  }
});

test('HTTP 登录页、缺失资源和错误核心响应都不能通过', () => {
  const login = observation();
  login.plugins['luci-app-homeproxy'].ui.authenticated = false;
  assert.throws(() => validatePluginResults(login, packages), /homeproxy|认证/);
  const empty = observation();
  empty.plugins['luci-app-nikki'].ui.assets[0].bytes = 0;
  assert.throws(() => validatePluginResults(empty, packages), /nikki|资源/);
  const wrong = observation();
  wrong.plugins['luci-app-homeproxy'].runtime.localResponseSha256 = hash('not the local fixture');
  assert.throws(() => validatePluginResults(wrong, packages), /homeproxy/);
});

test('不得将真实浏览器操作、远端业务或刷写伪装为已覆盖', () => {
  const result = observation();
  result.coverage.externalServices = 'passed';
  assert.throws(() => validatePluginResults(result, packages), /覆盖|external/);
});

test('不得用其他应用的成功页面冒充当前插件 UI', () => {
  const result = observation();
  result.plugins['luci-app-homeproxy'].ui = structuredClone(result.plugins['luci-app-autoreboot'].ui);
  assert.throws(() => validatePluginResults(result, packages), /homeproxy|入口|页面/);
});

async function localFixture(t, responseMode = 'valid', destroyFails = false, application = 'autoreboot', runtimeOverrides = {}) {
  const session = '1234567890abcdef1234567890abcdef';
  const viewName = application === 'nikki' ? 'nikki/app' : application;
  const route = application === 'autoreboot' ? 'admin/system/autoreboot' : 'admin/services/' + application;
  const html = '<html><link href="/luci-static/kucat/css/style.css"><script>ui.instantiateView(\'' + viewName + '\');</script></html>';
  const server = http.createServer((request, response) => {
    if (request.url === '/cgi-bin/luci/' + route) {
      if (responseMode === 'redirect') { response.writeHead(302, { Location: 'http://example.invalid/' }); response.end(); return; }
      if (!request.headers.cookie?.includes(session) || responseMode === 'login') {
        response.end('<form><input name="luci_password" type="password"></form>'); return;
      }
      response.end(html); return;
    }
    if (request.url === '/luci-static/resources/view/' + viewName + '.js' || request.url === '/luci-static/resources/tools/nikki.js') {
      response.end(responseMode === 'invalid-js' ? 'return { broken:' : "'use strict'; 'require view'; return view.extend({});"); return;
    }
    if (request.url.startsWith('/luci-static/kucat/')) { response.end('body { color: black; }'); return; }
    response.writeHead(404); response.end('missing');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = observation();
  const runtime = { ...base.plugins['luci-app-' + application].runtime, ...runtimeOverrides };
  if (application === 'nikki') { runtime.rpcJson = JSON.stringify(runtime.rpc); delete runtime.rpc; }
  const raw = { plugins: { ['luci-app-' + application]: { runtime,
    menu: JSON.stringify({ [route]: { action: { type: 'view', path: viewName } } }) } },
    theme: { mediaurlbase: '/luci-static/kucat' }, cleanup: base.cleanup };
  const calls = [];
  const remote = async script => {
    calls.push(script);
    if (script.includes('ubus call session create')) return { stdout: JSON.stringify({ ubus_rpc_session: session }), stderr: '' };
    if (script.includes('ubus call session destroy')) {
      if (destroyFails) throw new Error('session destroy failed');
      return { stdout: '{}', stderr: '' };
    }
    if (script.includes('ubus call session grant')) return { stdout: '', stderr: '' };
    return { stdout: JSON.stringify(raw), stderr: '' };
  };
  return { remote, calls, session, origin: 'http://127.0.0.1:' + server.address().port,
    packages: ['luci-app-' + application, 'luci-theme-kucat'] };
}

test('通过真实 HTTP 请求核对认证页面和 JS，报告不保存会话凭据', async t => {
  const input = await localFixture(t);
  const result = await checkPlugins(input);
  assert.equal(result.plugins['luci-app-autoreboot'].ui.authenticated, true);
  assert.equal(result.plugins['luci-app-autoreboot'].ui.assets[0].status, 200);
  assert.equal(JSON.stringify(result).includes(input.session), false);
  assert.equal(validatePluginResults(result, input.packages), true);
});

test('页面返回 HTTP 200 但实际未认证时失败并回收会话', async t => {
  const input = await localFixture(t, 'login');
  await assert.rejects(checkPlugins(input), /登录|认证/);
  assert.equal(input.calls.filter(script => script.includes('ubus call session destroy')).length, 1);
});

test('真实 guest JSON 中的 FRPC 启动诊断与 Nikki RPC 必须解析后验证', async t => {
  for (const application of ['frpc', 'nikki']) {
    const input = await localFixture(t, 'valid', false, application);
    const result = await checkPlugins(input);
    const runtime = result.plugins['luci-app-' + application].runtime;
    if (application === 'frpc') assert.match(runtime.startupDiagnostic, /127\.0\.0\.1:1.*connection refused/);
    else assert.equal(runtime.rpc.core, 'v1.19.18');
    assert.equal(runtime.rpcJson, undefined);
  }
});

test('checkPlugins 保留 FRPC 0.51.3 的真实版本与退出 0', async t => {
  const input = await localFixture(t, 'valid', false, 'frpc', { coreVersion: '0.51.3', startupExit: 0 });
  const result = await checkPlugins(input);
  assert.equal(result.plugins['luci-app-frpc'].runtime.coreVersion, '0.51.3');
  assert.equal(result.plugins['luci-app-frpc'].runtime.startupExit, 0);
});

test('插件 JS 语法错误或重定向到外部地址时拒绝', async t => {
  for (const mode of ['invalid-js', 'redirect']) {
    const input = await localFixture(t, mode);
    await assert.rejects(checkPlugins(input), mode === 'invalid-js' ? /语法|Syntax|资源/ : /重定向|地址/);
  }
});

test('只接受显式回环 HTTP 转发地址，且在执行远端命令之前拒绝其他地址', async () => {
  let calls = 0;
  const remote = async () => { calls++; return { stdout: '{}', stderr: '' }; };
  for (const origin of ['http://example.com', 'http://127.0.0.1@example.com', 'http://localhost:8080', 'http://127.0.0.1:8080/path']) {
    await assert.rejects(checkPlugins({ remote, origin, packages }), /127\.0\.0\.1|回环|地址/);
  }
  assert.equal(calls, 0);
});

test('命令失败与会话回收失败必须传播，不能报告成功', async t => {
  await assert.rejects(checkPlugins({ remote: async () => { throw new Error('core failed'); },
    origin: 'http://127.0.0.1:8080', packages }), /core failed/);
  const input = await localFixture(t, 'valid', true);
  await assert.rejects(checkPlugins(input), /session destroy failed|回收/);
});
