const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');

const repo = path.resolve(__dirname, '..');
const tmp = path.join(repo, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const dir = fs.mkdtempSync(path.join(tmp, 'immortalwrt-workflow-test-'));
const files = [
  '.github/workflows/Immortalwrt.yml', '.github/workflows/compile.yml',
  'tools/apply-custom-steps.sh', 'tools/immortalwrt-config.sh',
  'tools/prepare-immortalwrt.sh', 'tools/patches/immortalwrt-common.patch',
  'build/Immortalwrt/patches/001-kconfig-reciprocal-conflicts.patch',
  'tools/immortalwrt-release.cjs', '.github/actions/immortalwrt-release/action.yml',
  '.github/actions/immortalwrt-mishi/action.yml',
  '.github/workflows/keepalive.yml', '.github/workflows/runner-diagnostics.yml',
];
for (const name of files) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repo, name), target);
}
const first = path.join(dir, files[0]);
const second = path.join(dir, files[1]);
const configDirectory = path.join(dir, 'build/Immortalwrt');
fs.mkdirSync(path.join(configDirectory, 'seed'), { recursive: true });
fs.writeFileSync(path.join(configDirectory, 'settings.ini'), 'CONFIG_FILE="x86_64 x86_64_250"\n');
for (const config of ['x86_64', 'x86_64_250', 'armsr_rootfs_tar_gz']) {
  fs.writeFileSync(path.join(configDirectory, 'seed', config), 'CONFIG_TARGET_TEST=y\n');
}
for (const name of ['diy-part.sh', 'diy-part-250.sh']) fs.writeFileSync(path.join(configDirectory, name), '#!/bin/bash\n');
let matrixSequence = 0;

after(() => {
  const target = fs.realpathSync(dir);
  assert.ok(target.startsWith(fs.realpathSync(tmp) + path.sep));
  fs.rmSync(target, { recursive: true });
});

function run(check) {
  return spawnSync('bash', ['-s'], {
    input: 'export PATH="/usr/bin:/bin"\nbash tools/apply-custom-steps.sh' + (check ? ' --check' : '') + '\n',
    cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
}

function step(text, name) {
  const marker = '    - name: ' + name + '\n';
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, '缺少步骤: ' + name);
  const next = text.indexOf('    - name:', start + marker.length);
  return text.slice(start, next < 0 ? text.length : next);
}

function runMatrix(file, event, choice) {
  const lines = step(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), '生成配置矩阵').split('\n');
  const at = lines.findIndex(line => line.startsWith('      run:'));
  assert.ok(at >= 0, '缺少矩阵运行命令');
  let script = lines[at].slice('      run:'.length).trim();
  if (script === '|') {
    const body = [];
    for (let i = at + 1; i < lines.length; i++) {
      if (lines[i].trim() && !lines[i].startsWith('        ')) break;
      body.push(lines[i].slice(8));
    }
    script = body.join('\n');
  }
  const values = { 'github.event_name': event, 'github.event.inputs.CONFIG_FILE': choice };
  const render = text => text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, name) => {
    assert.ok(Object.hasOwn(values, name), '未知矩阵上下文: ' + name);
    return values[name];
  });
  const input = lines.slice(0, at).find(line => line.startsWith('        INPUT_CONFIG:'));
  const output = path.join(dir, 'matrix-' + (++matrixSequence) + '.txt');
  const result = spawnSync('bash', ['-s'], {
    input: 'export PATH="/usr/bin:/bin:$PATH"\nset -e\n' + render(script) + '\n',
    cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, INPUT_CONFIG: input ? render(input.slice('        INPUT_CONFIG:'.length).trim()) : '',
      GITHUB_OUTPUT: output.replaceAll('\\', '/') },
  });
  assert.ifError(result.error);
  return { ...result, configs: fs.existsSync(output)
    ? JSON.parse(fs.readFileSync(output, 'utf8').trim().replace(/^configs=/, '')) : undefined };
}

test('同步覆盖后能恢复修复调用及失败传播，重复运行不产生改动', () => {
  for (const file of [first, second]) {
    let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (file === first) text = text.replace(/^  plan:\n[\s\S]*?(?=^  build:)/m, '');
    text = text.replace(/actions\/checkout@[^\r\n]+/g, 'actions/checkout@v4');
    text = text.replace('      with:\n        ref: ${{ github.ref_name }}\n', '');
    text = text.replace('      with:\n        ref: ${{ github.sha }}\n', '');
    text = text.replace('    - name: 应用上游编译修复\n      run: bash tools/prepare-immortalwrt.sh\n\n', '');
    text = text.replace('    - name: 还原长期配置和diy脚本\n      run: bash tools/immortalwrt-config.sh restore\n\n', '');
    text = text.replace(/    - name: 生成发布标题和插件说明\n[\s\S]*?(?=    - name:|$)/, '');
    text = text.replace('      uses: ./.github/actions/immortalwrt-mishi\n      with:\n        config_file: ${{ matrix.config_file }}', '      uses: 281677160/common@mishi');
    text = text.replace('      uses: ./.github/actions/immortalwrt-mishi', '      uses: 281677160/common@mishi');
    for (const name of ['清理releases和workflows', '整理固件文件夹(需配合diy-part.sh设定使用)', '发送[在线更新固件]至云端']) {
      text = text.replace('    - name: ' + name + '\n', '    - name: ' + name + '\n      continue-on-error: true\n');
    }
    text = text.replace(
      '        export TMP_DIR="${RUNNER_TEMP}/immortalwrt-dependencies"\n        mkdir -p "$TMP_DIR"\n        sudo --preserve-env=DEBIAN_FRONTEND,TMP_DIR bash -e -o pipefail "${LINSHI_COMMON}/custom/ubuntu.sh"',
      "        sudo bash -c 'bash <(curl -fsSL https://github.com/281677160/common/raw/main/custom/ubuntu.sh)'"
    );
    text = text.replace('        bash -e "${COMMON_SH}" Diy_firmware', '        bash ${{ env.COMMON_SH }} Diy_firmware');
    text = text.replace('      uses: ./.github/actions/immortalwrt-release', '      uses: 281677160/common@cloud');
    fs.writeFileSync(file, text);
  }
  const before = [fs.readFileSync(first), fs.readFileSync(second)];
  const check = run(true);
  assert.ifError(check.error);
  assert.notEqual(check.status, 0, '检查模式必须发现缺失修复');
  assert.deepEqual([fs.readFileSync(first), fs.readFileSync(second)], before, '检查模式不能修改 workflow');

  const restored = run(false);
  assert.ifError(restored.error);
  assert.equal(restored.status, 0, restored.stderr + restored.stdout);
  const one = fs.readFileSync(first, 'utf8');
  const two = fs.readFileSync(second, 'utf8');
  for (const text of [one, two]) {
    const hook = text.indexOf('run: bash tools/prepare-immortalwrt.sh');
    const mishi = text.indexOf('uses: ./.github/actions/immortalwrt-mishi');
    assert.ok(mishi >= 0 && hook > mishi);
    assert.ok(hook < text.indexOf('    - name: 部署编译环境'));
    assert.equal(text.split('run: bash tools/prepare-immortalwrt.sh').length, 2, '只恢复一次修复步骤');
  }
  assert.ok(one.indexOf('run: bash tools/prepare-immortalwrt.sh') > one.indexOf('run: bash tools/immortalwrt-config.sh restore'));
  assert.ok(step(one, '检测密匙/文件/版本').includes('config_file: ${{ matrix.config_file }}'), 'restore 不能截断 mishi 的 with 输入块');
  assert.ok(!step(one, '清理releases和workflows').includes('continue-on-error:'));
  for (const name of ['整理固件文件夹(需配合diy-part.sh设定使用)', '发送[在线更新固件]至云端']) {
    assert.ok(!step(two, name).includes('continue-on-error:'));
  }
  const deployment = step(two, '部署编译环境');
  assert.ok(deployment.includes('sudo --preserve-env=DEBIAN_FRONTEND,TMP_DIR bash -e -o pipefail "${LINSHI_COMMON}/custom/ubuntu.sh"'));
  assert.ok(deployment.includes('mkdir -p "$TMP_DIR"'));
  assert.ok(!deployment.includes('curl -fsSL'));
  assert.ok(step(two, '整理固件文件夹(需配合diy-part.sh设定使用)').includes('bash -e "${COMMON_SH}" Diy_firmware'));
  const description = step(two, '生成发布标题和插件说明');
  assert.ok(description.includes('await release.describe()'));
  assert.ok(two.indexOf(description) > two.indexOf('    - name: 开始编译固件'));
  assert.ok(two.indexOf(description) < two.indexOf('    - name: 整理固件文件夹(需配合diy-part.sh设定使用)'), '清单删除前必须生成说明');
  assert.ok(step(two, '发送[在线更新固件]至云端').includes('uses: ./.github/actions/immortalwrt-release'));
  assert.ok(one.includes("cron: '05 22 * * 5'"), '长期定时不能被补回操作改写');

  const again = run(false);
  assert.ifError(again.error);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(fs.readFileSync(first, 'utf8'), one);
  assert.equal(fs.readFileSync(second, 'utf8'), two);
  assert.equal(run(true).status, 0);
});

test('上游仅恢复旧 checkout 时也能检测并升级，保留所有检出参数和缩进', () => {
  const targets = [first, second, path.join(dir, '.github/workflows/keepalive.yml'),
    path.join(dir, '.github/workflows/runner-diagnostics.yml')];
  const expected = targets.map(file => fs.readFileSync(file, 'utf8'));
  const oldReferences = ['actions/checkout@v4', 'actions/checkout@v4',
    '"actions/checkout@v4.2.2"', "'actions/checkout@v4'"];
  for (let i = 0; i < targets.length; i++) {
    fs.writeFileSync(targets[i], expected[i].replace(/actions\/checkout@[^\r\n]+/g, oldReferences[i]));
  }
  const outdated = targets.map(file => fs.readFileSync(file, 'utf8'));
  const checked = run(true);
  assert.ifError(checked.error);
  assert.notEqual(checked.status, 0, '旧 checkout 运行时不能被检查为全部到位');
  assert.deepEqual(targets.map(file => fs.readFileSync(file, 'utf8')), outdated, '检查模式不能升级文件');
  const restored = run(false);
  assert.ifError(restored.error);
  assert.equal(restored.status, 0, restored.stderr + restored.stdout);
  const normalizeNewlines = text => text.replace(/\r\n/g, '\n').replace(/\n?$/, '\n');
  assert.deepEqual(targets.map(file => normalizeNewlines(fs.readFileSync(file, 'utf8'))), expected.map(normalizeNewlines));
  assert.equal(run(true).status, 0);
});

for (const [event, choice, expected] of [
  ['workflow_dispatch', 'x86_64', ['x86_64']],
  ['workflow_dispatch', 'x86_64_250', ['x86_64_250']],
  ['workflow_dispatch', 'armsr_rootfs_tar_gz', ['armsr_rootfs_tar_gz']],
  ['schedule', '', ['x86_64', 'x86_64_250']],
]) {
  test(event + '/' + (choice || '长期列表') + ' 在正式和补回入口中生成正确矩阵', () => {
    for (const file of [path.join(repo, files[0]), first]) {
      const result = runMatrix(file, event, choice);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.deepEqual(result.configs, expected);
    }
  });
}

test('已撤下的手动测试输入不能再触发长期双配置', () => {
  for (const file of [path.join(repo, files[0]), first]) {
    const result = runMatrix(file, 'workflow_dispatch', '双配置测试');
    assert.notEqual(result.status, 0, '旧测试输入仍能启动双配置');
    assert.equal(result.configs, undefined, '无效配置不能输出矩阵');
  }
});
