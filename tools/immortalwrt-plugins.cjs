const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');

const KUCAT_PACKAGES = Object.freeze(['luci-theme-kucat', 'luci-app-kucat-config', 'luci-i18n-kucat-config-zh-cn']);
const BASELINE_LUCI = Object.freeze(['luci-app-autoupdate', 'luci-app-firewall', 'luci-app-opkg', 'luci-app-package-manager']);
const selected = text => new Set([...text.matchAll(/^CONFIG_PACKAGE_([^\s=]+)=y\r?$/gm)].map(match => match[1]));

function repairKucatAcl(home) {
  const filename = path.join(home, 'package/luci-theme-kucat/root/usr/share/rpcd/acl.d/luci-theme-kucat.json');
  const source = fs.readFileSync(filename, 'utf8');
  try { JSON.parse(source); return; }
  catch (error) {
    const normalized = source.replace(/\r\n/g, '\n');
    // 上游 1c8e7f7 的原件见 fixtures/kucat-acl-origin.json；只修复已确认的末尾多余括号。
    if (createHash('sha256').update(normalized).digest('hex') !== '6735d53a777870c10a2afc2f1706818748da844b076f398316cc4afa159b0f40') {
      throw new Error('kucat ACL 出现未知 JSON 错误: ' + filename, { cause: error });
    }
    const repaired = normalized.replace(/}\s*$/, '');
    JSON.parse(repaired);
    fs.writeFileSync(filename, repaired);
    console.log('已修复上游 kucat ACL 末尾的多余括号');
  }
}

function requestedPlugins(seed) {
  return [...new Set([...selected(seed)].filter(name => /^luci-(app|theme)-/.test(name)).concat(KUCAT_PACKAGES))].sort();
}

function rewritePackages(text, packages, enabled) {
  const names = new Set(packages);
  const kept = text.replace(/\r\n/g, '\n').split('\n').filter(line => {
    const match = line.match(/^(?:CONFIG_PACKAGE_([^\s=]+)=.*|# CONFIG_PACKAGE_([^\s]+) is not set)$/);
    return !match || !names.has(match[1] || match[2]);
  }).join('\n').replace(/\n*$/, '');
  const lines = packages.map(name => enabled ? 'CONFIG_PACKAGE_' + name + '=y' : '# CONFIG_PACKAGE_' + name + ' is not set');
  return (kept ? kept + '\n' : '') + lines.join('\n') + '\n';
}

function selectPackages(text, packages) {
  return rewritePackages(text, packages, true);
}

function enabledLuci(text) {
  return [...text.matchAll(/^CONFIG_PACKAGE_(luci-(?:app|theme)-[^\s=]+)=(y|m)\r?$/gm)].map(match => match[1]);
}

function extraI18n(text, allowed) {
  const stems = new Set(['base']);
  for (const name of allowed) {
    if (name.startsWith('luci-app-')) stems.add(name.slice(9));
    else if (name.startsWith('luci-theme-')) stems.add(name.slice(11));
  }
  const extras = [];
  for (const match of text.matchAll(/^CONFIG_PACKAGE_(luci-i18n-[^\s=]+)=(y|m)\r?$/gm)) {
    const rest = match[1].slice('luci-i18n-'.length);
    const locales = ['zh-cn', 'zh_Hans', 'zh-tw', 'pt-br', 'pt-pt'];
    let stem;
    for (const locale of locales) {
      if (rest.endsWith('-' + locale)) { stem = rest.slice(0, -(locale.length + 1)); break; }
    }
    stem ||= rest.match(/^(.+)-[a-z]{2}$/)?.[1];
    if (!stem || !stems.has(stem)) extras.push(match[1]);
  }
  return extras;
}

function required(env, name) {
  if (!env[name]) throw new Error('缺少插件校验参数: ' + name);
  return env[name];
}

function ensurePlugins({ env = process.env, updateSeed = false, run = spawnSync } = {}) {
  const root = required(env, 'GITHUB_WORKSPACE');
  const home = required(env, 'HOME_PATH');
  const folder = required(env, 'FOLDER_NAME');
  const config = required(env, 'CONFIG_FILE');
  if (![folder, config].every(value => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error('插件校验的目录或配置标识无效');
  const output = updateSeed ? required(env, 'CONFIG_TXT') : null;
  // operates 和 CONFIG_TXT 已经过上游改写，不能用它们推断用户原始选择。
  const seed = fs.readFileSync(path.join(root, 'build', folder, 'seed', config), 'utf8');
  const requested = requestedPlugins(seed);
  const allowed = new Set([...requested, ...BASELINE_LUCI]);
  repairKucatAcl(home);
  const configPath = path.join(home, '.config');
  fs.writeFileSync(configPath, selectPackages(fs.readFileSync(configPath, 'utf8'), KUCAT_PACKAGES));

  const execute = (file, args, options = {}) => {
    const result = run(file, args, { cwd: home, encoding: 'utf8', windowsHide: true, stdio: 'inherit', ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(file + ' ' + args.join(' ') + ' 失败，退出码: ' + result.status +
      (result.stderr?.trim() ? '\n' + result.stderr.trim() : ''));
    return result.stdout;
  };
  execute('make', ['defconfig']);
  let generated = fs.readFileSync(configPath, 'utf8');
  const extras = [...new Set([...enabledLuci(generated).filter(name => !allowed.has(name)), ...extraI18n(generated, allowed)])];
  if (extras.length) {
    fs.writeFileSync(configPath, rewritePackages(generated, extras, false));
    execute('make', ['defconfig']);
    generated = fs.readFileSync(configPath, 'utf8');
  }
  const actual = selected(generated);
  const missing = requested.filter(name => !actual.has(name));
  if (missing.length) throw new Error('请求的插件未进入最终配置: ' + missing.join(', '));
  const leftover = [...new Set([...enabledLuci(generated).filter(name => !allowed.has(name)), ...extraI18n(generated, allowed)])];
  if (leftover.length) throw new Error('未请求的插件进入最终配置: ' + leftover.join(', '));

  if (updateSeed) {
    const next = execute('bash', [path.join(home, 'scripts/diffconfig.sh')], { stdio: 'pipe' });
    if (!next?.trim()) throw new Error('diffconfig 生成的 seed 为空');
    // 保留明确请求，即使当前已被其他包作为依赖选中，后续也不能悄悄消失。
    fs.writeFileSync(output, selectPackages(next, requested));
  }
  return requested;
}

module.exports = { KUCAT_PACKAGES, BASELINE_LUCI, requestedPlugins, ensurePlugins };
if (require.main === module) {
  try {
    const { values } = parseArgs({ options: { 'write-seed': { type: 'boolean', default: false } } });
    const plugins = ensurePlugins({ updateSeed: values['write-seed'] });
    console.log('已核验所选插件: ' + plugins.join(', '));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}