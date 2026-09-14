const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const APPLICATIONS = new Set(['autoreboot', 'autoupdate', 'firewall', 'frpc', 'homeproxy', 'kucat-config', 'nikki', 'package-manager', 'opkg']);
const LOCAL_RESPONSE = 'immortalwrt-plugin-local-ok\n';
const digest = value => createHash('sha256').update(value).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const coverage = () => ({ browserInteraction: 'not_tested', externalServices: 'not_tested',
  firmwareUpgrade: 'not_tested', scheduledReboot: 'not_tested', transparentProxy: 'not_tested',
  frpcTunnel: 'not_tested', frpcAdminApi: 'not_tested' });

function selectedPackages(packages) {
  check(Array.isArray(packages) && packages.length && packages.every(name => typeof name === 'string' && /^[a-z0-9][a-z0-9+_.-]*$/.test(name)), '插件软件包清单无效');
  const selected = packages.filter(name => name.startsWith('luci-app-'));
  check(selected.length || packages.includes('luci-theme-kucat'), '清单中没有可验收的插件或 kucat 主题');
  for (const name of selected) check(APPLICATIONS.has(name.slice(9)), '尚无此插件的运行验收实现: ' + name);
  check(new Set(selected).size === selected.length, '插件清单存在重复项');
  check(!(selected.includes('luci-app-opkg') && selected.includes('luci-app-package-manager')), '包管理插件的原生名称不唯一');
  return selected;
}

function validAsset(asset, name) {
  check(asset && /^\/luci-static\/[a-zA-Z0-9_./-]+$/.test(asset.path) && asset.status === 200 && asset.bytes > 0 && /^[a-f0-9]{64}$/.test(asset.sha256), name + ' 静态资源缺失或为空');
  if (asset.path.endsWith('.js')) check(asset.syntax === 'valid', name + ' JavaScript 资源语法未通过');
}

function validViewIdentity(name, view, route) {
  const family = name.slice(9);
  const families = ['opkg', 'package-manager'].includes(family) ? ['opkg', 'package-manager'] : [family];
  check(families.includes(view.split('/')[0]) && families.includes(route.split('/')[5]), name + ' LuCI 入口指向了其他插件页面');
}

function validateRuntime(name, runtime) {
  const r = runtime || {};
  const requireRuntime = (condition, detail) => check(condition, name + ' 本机运行证据不足: ' + detail);
  switch (name.slice(9)) {
    case 'autoreboot':
      requireRuntime(r.shellSyntaxExit === 0 && r.configReadable === true, '脚本与 UCI');
      requireRuntime(/^17 3 \* \* 2 .*\breboot\b.*#autoreboot_smoke$/.test(r.generatedSchedule) && r.installedSchedule === false, '仅生成测试计划，不安装计划任务');
      break;
    case 'autoupdate':
      requireRuntime(r.shellSyntaxExit === 0 && r.luaSyntaxExit === 0 && r.configReadable === true && r.metadataReadable === true, '脚本、Lua、UCI 与更新元数据');
      break;
    case 'firewall':
      requireRuntime(r.configCheckExit === 0 && r.generatedBytes > 0 && ['input', 'forward', 'output'].every(chain => r.loadedChains?.includes(chain)), 'fw4 规则校验与已加载链');
      break;
    case 'frpc':
      requireRuntime(r.configBytes > 0 && ((r.configCheckMethod === 'verify' && r.configCheckExit === 0) ||
        (r.configCheckMethod === 'startup-parser' && r.configCheckExit === null)), 'UCI 生成配置与核心解析');
      // FRPC 0.51.3 的 CLI 忽略 service.Run 返回值，受控拒连也会退出 0。
      requireRuntime((r.startupExit === 1 || (r.coreVersion === '0.51.3' && r.startupExit === 0)) &&
        /127\.0\.0\.1:1\b.*connection refused/i.test(r.startupDiagnostic), '核心已解析配置并报告受控回环连接失败');
      break;
    case 'homeproxy':
    case 'nikki':
      requireRuntime(r.generatorExit === 0 && r.generatedBytes > 0 && r.configCheckExit === 0, '真实插件生成器与核心配置校验');
      requireRuntime(r.localHttpStatus === 200 && r.localResponseSha256 === digest(LOCAL_RESPONSE), '通过本机代理转发固定响应');
      if (name === 'luci-app-homeproxy') requireRuntime(r.rpcAvailable === true, 'HomeProxy 只读 RPC');
      else requireRuntime(typeof r.rpc?.app === 'string' && r.rpc.app.length > 0 && typeof r.rpc.core === 'string' && r.rpc.core.length > 0, 'Nikki 真实版本 RPC');
      break;
    case 'kucat-config':
      requireRuntime(r.shellSyntaxExit === 0 && r.configReadable === true, '脚本与 UCI');
      requireRuntime(r.applied?.mode === 'dark' && r.applied?.primary_rgbm === '26,131,97' && r.applied?.font_d === '1.3rem', '实际应用测试配色与字号');
      break;
    case 'package-manager':
    case 'opkg':
      requireRuntime(['apk', 'opkg'].includes(r.backend) && ['package-manager-call', 'opkg-list-installed'].includes(r.queryMethod) && r.queryBytes > 0 && r.queriedPackages?.includes(name), '实际包管理后端只读查询');
      break;
  }
}

function validatePluginResults(result, packages) {
  const selected = selectedPackages(packages);
  check(result?.schema === 1 && result.scope === 'isolated-local-smoke', '插件验收报告格式或范围无效');
  check(result.cleanup?.configurationsRestored === true, '插件临时配置未确认恢复');
  check(result.cleanup?.cronUnchanged === true, '插件烟测改变了 cron 计划任务');
  check(result.cleanup?.processesStopped === true, '插件测试进程未确认退出');
  for (const key of Object.keys(coverage())) check(result.coverage?.[key] === 'not_tested', '插件报告不得夸大未覆盖范围: ' + key);
  check(result.plugins && typeof result.plugins === 'object', '缺少插件运行记录');
  for (const name of selected) {
    const plugin = result.plugins[name];
    check(plugin, '缺少插件运行记录: ' + name);
    validateRuntime(name, plugin.runtime);
    const ui = plugin.ui;
    check(ui?.status === 200 && ui.authenticated === true, name + ' LuCI 入口或认证失败');
    if (name === 'luci-app-autoupdate') {
      check(ui.kind === 'status' && ui.route === '/cgi-bin/luci/admin/system/autoupdate/check_status' && ui.mainForm === 'not_tested' &&
        ui.payload?.running === false && ui.payload?.is_upgrading === false && typeof ui.payload?.success === 'boolean', name + ' 只读状态入口异常');
    } else {
      check(ui.kind === 'view' && /^\/cgi-bin\/luci\/admin\/[a-zA-Z0-9_/-]+$/.test(ui.route) && typeof ui.view === 'string' &&
        Array.isArray(ui.assets) && ui.assets.some(asset => asset.path === '/luci-static/resources/view/' + ui.view + '.js'), name + ' LuCI 页面与 view 资源不匹配');
      validViewIdentity(name, ui.view, ui.route);
      ui.assets.forEach(asset => validAsset(asset, name));
    }
  }
  check(Object.keys(result.plugins).length === selected.length, '插件运行报告与所选插件清单不一致');
  if (packages.includes('luci-theme-kucat')) {
    check(result.theme?.name === 'kucat' && result.theme.mediaurlbase === '/luci-static/kucat' && result.theme.htmlUsesTheme === true, 'kucat 实际主题未生效');
    check(Array.isArray(result.theme.assets) && result.theme.assets.some(asset => asset.path === '/luci-static/kucat/css/style.css'), '缺少 kucat 主题资源');
    result.theme.assets.forEach(asset => validAsset(asset, 'kucat'));
  }
  return true;
}

function localOrigin(value) {
  const origin = new URL(value);
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && !origin.username && !origin.password &&
    origin.pathname === '/' && !origin.search && !origin.hash, '插件烟测仅接受 127.0.0.1 的 HTTP 回环转发地址');
  return origin.origin;
}

async function getPage(origin, route, cookie) {
  let target = new URL(route, origin);
  for (let redirects = 0; redirects < 5; redirects++) {
    check(target.origin === origin, 'LuCI 重定向离开了隔离测试地址');
    const response = await fetch(target, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(20000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      check(location, 'LuCI 重定向没有目标地址');
      target = new URL(location, target);
      continue;
    }
    const body = await response.text();
    check(response.status === 200, 'LuCI 请求失败: ' + route + ' HTTP ' + response.status);
    check(!/Runtime error|Internal Server Error|Unhandled exception/.test(body), 'LuCI 运行错误: ' + route);
    return { body, status: response.status };
  }
  throw new Error('LuCI 重定向次数过多: ' + route);
}

async function inspectAsset(origin, resource) {
  check(/^\/luci-static\/[a-zA-Z0-9_/-]+(?:\.[a-z0-9]+)$/.test(resource) && !resource.includes('..'), '插件资源地址无效');
  const { status, body } = await getPage(origin, resource);
  check(body.trim().length > 0 && !/^\s*<(?:!doctype|html|form)\b/i.test(body), '插件资源为空或返回了 HTML: ' + resource);
  const result = { path: resource, status, bytes: Buffer.byteLength(body), sha256: digest(body) };
  if (resource.endsWith('.js')) {
    try { new Function(body); } catch (error) { throw new Error('插件资源语法错误: ' + resource + ': ' + error.message); }
    result.syntax = 'valid';
  }
  return result;
}

function mainView(menu, name) {
  const entries = Object.entries(JSON.parse(menu));
  const views = entries.filter(([, entry]) => entry.action?.type === 'view').sort((left, right) => (left[1].order || 0) - (right[1].order || 0));
  check(views.length, name + ' 没有可验收的 LuCI view');
  const [route, entry] = views[0];
  check(/^admin\/[a-zA-Z0-9_/-]+$/.test(route) && /^[a-zA-Z0-9_/-]+$/.test(entry.action.path) && !route.includes('..'), name + ' 菜单入口无效');
  validViewIdentity(name, entry.action.path, '/cgi-bin/luci/' + route);
  return { route: '/cgi-bin/luci/' + route, view: entry.action.path };
}

async function createSession(remote) {
  const raw = await remote("ubus call session create '{\"timeout\":300}'\n");
  const session = JSON.parse(raw.stdout).ubus_rpc_session;
  check(/^[a-f0-9]{32}$/.test(session), '无法创建隔离 LuCI 测试会话');
  return session;
}

async function grantSession(remote, session) {
  const token = randomBytes(16).toString('hex');
  const grant = JSON.stringify({ ubus_rpc_session: session, scope: 'ubus', objects: [['*', '*']] });
  const values = JSON.stringify({ ubus_rpc_session: session, values: { username: 'root', token } });
  // 仅在一次性 COW 虚拟机内创建短时会话；不读取或修改路由器密码。
  await remote(`set -e
ubus call session grant ${quote(grant)} >/dev/null
ubus call session set ${quote(values)} >/dev/null
. /usr/share/libubox/jshn.sh
groups=$(ucode -e 'import { glob, readfile } from "fs"; for (let file in glob("/usr/share/rpcd/acl.d/*.json")) for (let name in keys(json(readfile(file)))) print(name, "\\n");')
json_init
json_add_string ubus_rpc_session ${quote(session)}
json_add_string scope access-group
json_add_array objects
for group in $groups; do
  json_add_array ''
  json_add_string '' "$group"
  json_add_string '' read
  json_close_array
done
json_close_array
ubus call session grant "$(json_dump)" >/dev/null
`);
}

async function checkPlugins({ remote, origin, packages }) {
  const selected = selectedPackages(packages);
  check(typeof remote === 'function', '缺少隔离虚拟机 SSH 执行接口');
  origin = localOrigin(origin);
  const script = await fs.readFile(path.join(__dirname, 'immortalwrt-plugin-runtime.sh'), 'utf8');
  const raw = JSON.parse((await remote('PLUGIN_PACKAGES=' + quote(selected.join(' ')) + '\nPLUGIN_THEME=' +
    quote(packages.includes('luci-theme-kucat') ? 'kucat' : '') + '\n' + script, 180000)).stdout);
  const result = { schema: 1, scope: 'isolated-local-smoke', plugins: {}, theme: null, cleanup: raw.cleanup, coverage: coverage() };
  const session = await createSession(remote);
  let failure;
  try {
    await grantSession(remote, session);
    const cookie = 'sysauth_http=' + session + '; sysauth=' + session;
    let themedHtml = false;
    for (const name of selected) {
      const observed = raw.plugins?.[name];
      check(observed, '缺少插件远端运行结果: ' + name);
      const runtime = { ...observed.runtime };
      if (name === 'luci-app-nikki') {
        runtime.rpc = JSON.parse(runtime.rpcJson);
        delete runtime.rpcJson;
      }
      if (name === 'luci-app-autoupdate') {
        const route = '/cgi-bin/luci/admin/system/autoupdate/check_status';
        const page = await getPage(origin, route, cookie);
        check(!/<form\b|luci_password/.test(page.body), 'AutoUpdate 只读入口返回了登录页');
        const payload = JSON.parse(page.body);
        result.plugins[name] = { runtime,
          ui: { kind: 'status', route, status: page.status, authenticated: true,
            payload: { running: payload.running, is_upgrading: payload.is_upgrading, success: payload.success }, mainForm: 'not_tested' } };
        continue;
      }
      const entry = mainView(observed.menu, name);
      const page = await getPage(origin, entry.route, cookie);
      check(!/name=["']luci_password["']|type=["']password["']/.test(page.body), name + ' 返回了登录页，未完成认证');
      const rendered = page.body.match(/instantiateView\(\s*["']([^"']+)["']/)?.[1];
      check(rendered === entry.view, name + ' LuCI 没有呈现所选插件 view');
      themedHtml ||= /\/luci-static\/kucat\//.test(page.body);
      const assets = [await inspectAsset(origin, '/luci-static/resources/view/' + entry.view + '.js')];
      if (name === 'luci-app-homeproxy') assets.push(await inspectAsset(origin, '/luci-static/resources/homeproxy.js'));
      if (name === 'luci-app-nikki') assets.push(await inspectAsset(origin, '/luci-static/resources/tools/nikki.js'));
      result.plugins[name] = { runtime,
        ui: { kind: 'view', ...entry, status: page.status, authenticated: true, assets } };
    }
    if (packages.includes('luci-theme-kucat')) {
      if (!themedHtml) {
        const page = await getPage(origin, '/cgi-bin/luci/admin/status/overview', cookie);
        themedHtml = /\/luci-static\/kucat\//.test(page.body) && !/luci_password/.test(page.body);
      }
      result.theme = { name: 'kucat', mediaurlbase: raw.theme?.mediaurlbase, htmlUsesTheme: themedHtml,
        assets: [await inspectAsset(origin, '/luci-static/kucat/css/style.css')] };
    }
    validatePluginResults(result, packages);
  } catch (error) { failure = error; }
  try {
    await remote('ubus call session destroy ' + quote(JSON.stringify({ ubus_rpc_session: session })) + '\n');
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], failure.message + '；LuCI 测试会话回收失败: ' + error.message);
    throw new Error('LuCI 测试会话回收失败: ' + error.message);
  }
  if (failure) throw failure;
  return result;
}

module.exports = { checkPlugins, validatePluginResults };
