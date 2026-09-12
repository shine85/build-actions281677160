const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function required(env, name) {
  if (!env[name]) throw new Error('缺少发布参数: ' + name);
  return env[name];
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
