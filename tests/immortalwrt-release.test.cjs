const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, after } = require('node:test');
const repo = path.resolve(__dirname, '..');
const tmp = path.join(repo, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const root = fs.mkdtempSync(path.join(tmp, 'immortalwrt-release-test-'));
let sequence = 0;
after(() => {
  const target = fs.realpathSync(root);
  assert.ok(target.startsWith(fs.realpathSync(tmp) + path.sep));
  fs.rmSync(target, { recursive: true });
});
function implementation() {
  const file = path.join(repo, 'tools/immortalwrt-release.cjs');
  assert.ok(fs.existsSync(file), '缺少发布产物校验与索引生成实现');
  return require(file);
}
function fixture() {
  const dir = path.join(root, String(++sequence));
  const bin = path.join(dir, 'firmware');
  fs.mkdirSync(bin, { recursive: true });
  const base = '24.10-Immortalwrt-x86-64-x86_64-1789171739';
  const assets = ['legacy', 'uefi'].map((boot, i) => {
    const name = base + '-' + boot + '-abcdef.img.gz';
    const content = Buffer.from('firmware-' + boot);
    fs.writeFileSync(path.join(bin, name), content);
    return { id: i + 1, name, size: content.length, state: 'uploaded', updated_at: '2026-09-12T00:42:00Z',
      digest: 'sha256:' + crypto.createHash('sha256').update(content).digest('hex'),
      browser_download_url: 'https://github.com/example/firmware/releases/download/Update-x86-x86_64/' + name };
  });
  const env = { BIN_PATH: bin, UPDATE_TAG: 'Update-x86-x86_64', TARGET_BOARD: 'x86',
    AUTOBUILD_FIRMWARE: base + '-legacy', AUTOBUILD_FIRMWARE_UEFI: base + '-uefi',
    FIRMWARE_SUFFIX: '.img.gz', RUNNER_TEMP: dir };
  const exported = {};
  const release = { id: 10, tag_name: env.UPDATE_TAG, assets };
  const list = async () => {};
  const github = {
    rest: { repos: {
      getReleaseByTag: async args => {
        assert.deepEqual(args, { owner: 'example', repo: 'firmware', tag: env.UPDATE_TAG });
        return { data: release };
      },
      listReleaseAssets: list,
      deleteReleaseAsset: async ({ asset_id }) => {
        release.assets = release.assets.filter(asset => asset.id !== asset_id);
      },
    } },
    paginate: async (method, args) => {
      assert.equal(method, list);
      assert.deepEqual(args, { owner: 'example', repo: 'firmware', release_id: 10, per_page: 100 });
      return release.assets;
    },
  };
  return { env, release, exported, args: { env, github, context: { repo: { owner: 'example', repo: 'firmware' } },
    core: { exportVariable: (name, value) => { exported[name] = value; }, info: () => {} } } };
}
test('两种固件完整上传后才生成包含实际资产的更新索引', async () => {
  const f = fixture();
  await implementation()(f.args);
  assert.ok(f.exported.AUTO_API);
  const index = JSON.parse(fs.readFileSync(f.exported.AUTO_API, 'utf8'));
  assert.equal(index.tag_name, 'Update-x86-x86_64');
  assert.deepEqual(index.assets.map(a => a.name).sort(), f.release.assets.map(a => a.name).sort());
});
test('缺少任一远端资产时拒绝生成索引', async () => {
  const f = fixture();
  f.release.assets.pop();
  await assert.rejects(implementation()(f.args), /缺少|数量/);
  assert.equal(f.exported.AUTO_API, undefined);
});
test('远端固件哈希不符时拒绝生成索引', async () => {
  const f = fixture();
  f.release.assets[1].digest = 'sha256:' + '0'.repeat(64);
  await assert.rejects(implementation()(f.args), /校验|哈希/);
});
test('远端固件大小不符时拒绝生成索引', async () => {
  const f = fixture();
  f.release.assets[0].size++;
  await assert.rejects(implementation()(f.args), /校验|大小/);
});
test('远端资产尚未完成上传时拒绝生成索引', async () => {
  const f = fixture();
  f.release.assets[0].state = 'starter';
  await assert.rejects(implementation()(f.args), /完成|状态/);
});
test('GitHub API 错误会传播为发布失败', async () => {
  const f = fixture();
  f.args.github.rest.repos.getReleaseByTag = async () => { throw new Error('Forbidden (403)'); };
  await assert.rejects(implementation()(f.args), /403/);
});
test('本地缺少 UEFI 固件时不发布不完整索引', async () => {
  const f = fixture();
  const uefi = f.release.assets[1].name;
  fs.renameSync(path.join(f.env.BIN_PATH, uefi), path.join(f.env.RUNNER_TEMP, uefi));
  await assert.rejects(implementation()(f.args), /缺少|数量/);
});

test('新通道的明确 404 允许首次发布，其他 API 错误不忽略', async () => {
  const f = fixture();
  f.args.github.rest.repos.getReleaseByTag = async () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
  await implementation().cleanup(f.args);
  assert.equal(f.exported.YUNDUAN_API, 'false');
  f.args.github.rest.repos.getReleaseByTag = async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); };
  await assert.rejects(implementation().cleanup(f.args), /Forbidden/);
});

test('旧固件清理只影响相同配置和格式，保留最近一版', async () => {
  const f = fixture();
  const current = { ...f.release.assets[0] };
  const old = { ...current, id: 20, name: current.name.replace('1789171739', '1788000000'), updated_at: '2026-09-01T00:00:00Z' };
  const other = { ...old, id: 21, name: old.name.replace('x86_64-', 'x86_64_250-') };
  f.release.assets.push(old, other);
  await implementation().cleanup(f.args);
  assert.ok(f.release.assets.some(asset => asset.id === current.id));
  assert.ok(!f.release.assets.some(asset => asset.id === 20));
  assert.ok(f.release.assets.some(asset => asset.id === 21));
});

test('删除旧资产失败会阻止发布继续进行', async () => {
  const f = fixture();
  const current = f.release.assets[0];
  f.release.assets.push({ ...current, id: 20, name: current.name.replace('1789171739', '1788000000'), updated_at: '2026-09-01T00:00:00Z' });
  f.args.github.rest.repos.deleteReleaseAsset = async () => { throw new Error('Delete failed (403)'); };
  await assert.rejects(implementation().cleanup(f.args), /403/);
  assert.equal(f.exported.YUNDUAN_API, 'false');
});
