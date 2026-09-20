const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIPv4 } = require('node:net');
const { readSettings } = require('./immortalwrt-network.cjs');
const { parseFirmwareManifest, readVerifiedNetwork } = require('./immortalwrt-verification.cjs');

function required(env, name) {
  if (!env[name]) throw new Error('缺少发布参数: ' + name);
  return env[name];
}

function networkDetails(diy) {
  const values = {};
  for (const name of ['Ipv4_ipaddr', 'Netmask_netm', 'Gateway_Settings']) {
    const matches = [...diy.matchAll(new RegExp('^export ' + name + '="([^"\\r\\n]+)"', 'gm'))];
    if (matches.length !== 1) throw new Error('无法唯一读取本次网络配置: ' + name);
    const value = matches[0][1];
    if (value !== '0' && !isIPv4(value)) throw new Error('无效 IPv4 地址或掩码: ' + name);
    values[name] = value;
  }
  const { Ipv4_ipaddr: address, Netmask_netm: mask, Gateway_Settings: gateway } = values;
  const maskBits = mask === '0' ? '' : mask.split('.').map(n => Number(n).toString(2).padStart(8, '0')).join('');
  if (maskBits && !/^1*0*$/.test(maskBits)) throw new Error('IPv4 子网掩码不连续');
  let subnet = '使用源码默认网络';
  if (address !== '0') {
    subnet = '使用源码默认掩码，网段未确定';
    if (maskBits) {
      const octets = mask.split('.').map(Number);
      subnet = address.split('.').map((n, i) => Number(n) & octets[i]).join('.') + '/' + maskBits.replace(/0/g, '').length;
    }
  }
  return { address, gateway, subnet };
}

// x86 的网络信息取实际启动验收结果，镜像哈希变化后旧报告不能继续使用。
async function describeRelease({ env = process.env, now } = {}) {
  const directory = required(env, 'FIRMWARE_PATH');
  const manifests = (await fs.promises.readdir(directory)).filter(name => name.endsWith('.manifest'));
  if (manifests.length !== 1) throw new Error('固件 manifest 清单缺失或存在多个设备，无法确定插件列表');
  const manifest = await fs.promises.readFile(path.join(directory, manifests[0]), 'utf8');
  const packages = new Set(parseFirmwareManifest(manifest));
  const apps = [...packages].filter(name => name.startsWith('luci-app-')).sort();
  const themes = [...packages].filter(name => name.startsWith('luci-theme-')).sort();
  const diy = await fs.promises.readFile(required(env, 'DIY_PT2_SH'), 'utf8');
  const config = required(env, 'CONFIG_FILE');
  const board = required(env, 'TARGET_BOARD');
  const network = board === 'x86' ? await readVerifiedNetwork({ directory, config, reportPath: env.IMMORTALWRT_RUNTIME_REPORT,
    settings: { ...readSettings(diy), sourceVersion: env.LUCI_EDITION }, packages: [...packages] }) : networkDetails(diy);
  const compiledDate = now || new Date(required(env, 'IMMORTALWRT_COMPILED_AT'));
  if (Number.isNaN(compiledDate.getTime())) throw new Error('编译完成时间无效');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(compiledDate).map(part => [part.type, part.value]));
  const compiledAt = `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}:${parts.second}（北京时间）`;
  const setting = value => value === '0' ? '使用源码默认配置' : '`' + value + '`';
  const body = [
    '编译时间：' + compiledAt,
    '',
    '| 项目 | 内容 |',
    '|---|---|',
    '| 网段 | `' + network.subnet + '` |',
    '| 默认管理地址 | ' + setting(network.address) + ' |',
    '| 默认网关 | ' + setting(network.gateway) + ' |',
    '| 编译配置 | `' + config + '` |',
    '',
    '**已编入固件的 LuCI 插件（' + apps.length + ' 项）**',
    '',
    ...(apps.length ? apps.map(name => '- `' + name + '`') : ['未编入 LuCI 插件。']),
    '',
    '**主题（' + themes.length + ' 项）**',
    '',
    ...(themes.length ? themes.map(name => '- `' + name + '`') : ['未编入 LuCI 主题。']),
    '',
  ].join('\n');
  return { name: `AutoUpdate-${board} · ${network.subnet} · ${config}`, body };
}

function inputs(env) {
  const prefixes = [required(env, 'AUTOBUILD_FIRMWARE')];
  if (required(env, 'TARGET_BOARD') === 'x86') prefixes.push(required(env, 'AUTOBUILD_FIRMWARE_UEFI'));
  return { directory: required(env, 'BIN_PATH'), suffix: required(env, 'FIRMWARE_SUFFIX'),
    tag: required(env, 'UPDATE_TAG'), prefixes };
}

async function expectedFiles({ directory, suffix, prefixes }) {
  const filenames = await fs.promises.readdir(directory);
  const expected = prefixes.map(prefix => {
    const matches = filenames.filter(name => name.startsWith(prefix + '-') && name.endsWith(suffix) &&
      /^[a-f0-9]{6}$/.test(name.slice(prefix.length + 1, -suffix.length)));
    if (matches.length !== 1) throw new Error('本地固件缺少或数量异常: ' + prefix);
    return matches[0];
  });
  if (filenames.length !== expected.length) throw new Error('发布目录包含非预期文件');
  return expected;
}

// 在更新 zzz_api 前核对每个本地固件，部分上传、旧数据和 API 错误必须失败。
module.exports = async function writeReleaseIndex({ github, context, core, env = process.env }) {
  const input = inputs(env);
  const expected = await expectedFiles(input);

  const { data: release } = await github.rest.repos.getReleaseByTag({
    ...context.repo, tag: input.tag,
  });
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...context.repo, release_id: release.id, per_page: 100,
  });
  for (const name of expected) {
    const found = assets.filter(asset => asset.name === name);
    if (found.length !== 1) throw new Error('远端固件缺少或数量异常: ' + name);
    const asset = found[0];
    if (asset.state !== 'uploaded') throw new Error('远端固件上传尚未完成: ' + name);
    const file = path.join(input.directory, name);
    const stat = await fs.promises.stat(file);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if (asset.size !== stat.size || asset.digest !== 'sha256:' + hash.digest('hex')) {
      throw new Error('远端固件大小或哈希校验失败: ' + name);
    }
  }

  const index = {
    ...release,
    assets: assets.filter(asset => asset.name !== 'zzz_api')
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
  };
  const output = path.join(required(env, 'RUNNER_TEMP'), 'immortalwrt-release', 'zzz_api');
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  await fs.promises.writeFile(output, JSON.stringify(index, null, 2) + '\n', 'utf8');
  core.exportVariable('AUTO_API', output);
};

module.exports.describe = describeRelease;

// 保留每种引导格式最近的一份旧固件；本次上传后仍有上一版可用。
module.exports.cleanup = async function cleanupRelease({ github, context, core, env = process.env }) {
  const input = inputs(env);
  await expectedFiles(input);
  core.exportVariable('YUNDUAN_API', 'false');
  let release;
  try {
    ({ data: release } = await github.rest.repos.getReleaseByTag({ ...context.repo, tag: input.tag }));
  } catch (error) {
    if (error.status !== 404) throw error;
    core.info('首次发布到更新通道: ' + input.tag);
    return;
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...context.repo, release_id: release.id, per_page: 100,
  });
  for (const prefix of input.prefixes) {
    const family = prefix.match(/^(.*)-[0-9]+-(legacy|uefi|sysupgrade)$/);
    if (!family) throw new Error('固件前缀不符合发布约定: ' + prefix);
    const previous = assets.filter(asset => {
      const match = asset.name.match(/^(.*)-[0-9]+-(legacy|uefi|sysupgrade)-[a-f0-9]{6}(\..+)$/);
      return match && match[1] === family[1] && match[2] === family[2] &&
        match[3] === input.suffix && asset.state === 'uploaded';
    }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    for (const asset of previous.slice(1)) {
      await github.rest.repos.deleteReleaseAsset({ ...context.repo, asset_id: asset.id });
      core.info('已清理旧固件: ' + asset.name);
    }
  }
};
