const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, before, after } = require('node:test');

const repo = path.resolve(__dirname, '..');
const tmp = path.join(repo, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const dir = fs.mkdtempSync(path.join(tmp, 'immortalwrt-kconfig-test-'));
const fixture = path.join(__dirname, 'fixtures/immortalwrt');
fs.mkdirSync(path.join(dir, 'scripts'));
for (const name of ['package-metadata.pl', 'metadata.pm']) {
  fs.copyFileSync(path.join(fixture, name), path.join(dir, 'scripts', name));
}
fs.copyFileSync(path.join(fixture, 'mihomo.packageinfo'), path.join(dir, 'mihomo.packageinfo'));
const rawMetadata = fs.readFileSync(path.join(dir, 'mihomo.packageinfo'));

after(() => {
  const target = fs.realpathSync(dir);
  assert.ok(target.startsWith(fs.realpathSync(tmp) + path.sep));
  fs.rmSync(target, { recursive: true });
});

function shell(input) {
  const result = spawnSync('bash', ['-s'], {
    input: 'export PATH="/usr/bin:/bin:$PATH"\n' + input,
    cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

function edges(text) {
  const graph = [];
  let owner;
  for (const line of text.split('\n')) {
    const config = line.match(/^\s*config PACKAGE_(\S+)/);
    if (config) owner = config[1];
    const conflict = line.match(/^\s*depends on m \|\| \(PACKAGE_(\S+) != y\)/);
    if (conflict) graph.push([owner, conflict[1]]);
  }
  return graph;
}

let originalKconfig;
before(() => {
  originalKconfig = shell('perl scripts/package-metadata.pl config mihomo.packageinfo\n');
  const patch = fs.readFileSync(path.join(repo, 'build/Immortalwrt/patches/001-kconfig-reciprocal-conflicts.patch'), 'utf8');
  shell("patch --batch --fuzz=0 -p1 <<'PATCH'\n" + patch + '\nPATCH\n');
  shell('perl -c scripts/package-metadata.pl\n');
});

test('真实 Kconfig 生成器消除双向图环并保留包管理器冲突数据', () => {
  const originalEdges = edges(originalKconfig);
  assert.ok(originalEdges.some(([a, b]) => a === 'mihomo-alpha' && b === 'mihomo-meta'));
  assert.ok(originalEdges.some(([a, b]) => a === 'mihomo-meta' && b === 'mihomo-alpha'));
  const after = shell('perl scripts/package-metadata.pl config mihomo.packageinfo\n');
  const graph = edges(after);
  const mihomo = graph.filter(([a]) => a.startsWith('mihomo-'));
  assert.equal(mihomo.length, 1, '互相 CONFLICTS 必须只保留一个无环方向');
  assert.ok(graph.some(([a, b]) => a === 'probe-z' && b === 'probe-a'), '单向冲突不可丢失');
  assert.ok(graph.some(([a, b]) => a === 'probe-b' && b === 'probe-y'), '反字典序单向冲突不可丢失');
  assert.equal(after, originalKconfig.replace('\t\tdepends on m || (PACKAGE_mihomo-meta != y)\n', ''),
    'Nikki、虚包、默认变体与其他输出必须保持');

  for (const alpha of [0, 1, 2]) {
    for (const meta of [0, 1, 2]) {
      const states = { 'mihomo-alpha': alpha, 'mihomo-meta': meta };
      const allowed = mihomo.every(([a, b]) => states[a] <= Math.max(1, states[b] === 2 ? 0 : 2));
      assert.equal(allowed, !(alpha === 2 && meta === 2), '只禁止两个变体同时内置');
    }
  }
  assert.deepEqual(fs.readFileSync(path.join(dir, 'mihomo.packageinfo')), rawMetadata);
});

test('实际 Kconfig 解析器覆盖 provider 顺序及 select 反向依赖', () => {
  // 镜像子配置与包依赖无关，使用明确的空夹具，其他文件访问仍报错。
  fs.mkdirSync(path.join(dir, 'package/test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package/test/image-config.in'), '');
  const original = rawMetadata.toString('utf8');
  const noDefault = text => text.replace(/^Default-Variant:.*\r?\n/gm, '');
  const swappedNames = text => text.replaceAll('mihomo-alpha', 'mihomo-zeta').replaceAll('mihomo-meta', 'mihomo-beta');
  const blocks = original.split(/(?=^Source-Makefile:)/m).filter(Boolean);
  const definitions = [
    { name: 'default-meta', text: original },
    { name: 'default-alpha', text: noDefault(original).replace('Build-Variant: alpha\n', 'Build-Variant: alpha\nDefault-Variant: alpha\n') },
    { name: 'reversed-names', text: swappedNames(original), alpha: 'mihomo-zeta', meta: 'mihomo-beta' },
    { name: 'no-default', text: noDefault(original) },
    { name: 'no-default-reversed-order', text: noDefault([blocks[1], blocks[0], ...blocks.slice(2)].join('')) },
    { name: 'no-default-reversed-names', text: swappedNames(noDefault(original)), alpha: 'mihomo-zeta', meta: 'mihomo-beta' },
    { name: 'two-defaults', text: original.replace('Build-Variant: alpha\n', 'Build-Variant: alpha\nDefault-Variant: alpha\n') },
  ];
  const cases = definitions.map((definition, index) => {
    fs.writeFileSync(path.join(dir, 'case-' + index + '.packageinfo'), definition.text);
    return { name: definition.name, alpha: 'PACKAGE_' + (definition.alpha || 'mihomo-alpha'),
      meta: 'PACKAGE_' + (definition.meta || 'mihomo-meta'),
      text: shell('perl scripts/package-metadata.pl config case-' + index + '.packageinfo\n') };
  });
  let python = process.env.PYTHON || 'python3';
  if (!process.env.PYTHON && process.platform === 'win32') {
    const found = spawnSync('uv', ['python', 'find', '--offline', '--no-python-downloads'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.ifError(found.error);
    assert.equal(found.status, 0, '请设置 PYTHON 为已安装解释器路径，或提供 uv 的离线 Python');
    python = found.stdout.trim();
  }
  const result = spawnSync(python, ['-B', path.join(__dirname, 'validate-kconfig.py')], {
    input: JSON.stringify(cases), cwd: dir, env: { ...process.env, srctree: dir },
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const verified = JSON.parse(result.stdout);
  assert.equal(verified.length, 7);
  assert.equal(verified.reduce((sum, item) => sum + item.statesChecked, 0), 189);
});
