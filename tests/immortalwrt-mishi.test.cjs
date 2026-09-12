const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');

const repo = path.resolve(__dirname, '..');
const tmp = path.join(repo, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const root = fs.mkdtempSync(path.join(tmp, 'immortalwrt-mishi-test-'));
let count = 0;
after(() => {
  const target = fs.realpathSync(root);
  assert.ok(target.startsWith(fs.realpathSync(tmp) + path.sep));
  fs.rmSync(target, { recursive: true });
});

function block(text, name) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf('    - name: ' + name);
  assert.ok(start >= 0, '缺少步骤: ' + name);
  const next = lines.findIndex((line, i) => i > start && line.startsWith('    - name:'));
  return lines.slice(start, next < 0 ? lines.length : next);
}

function render(text, values) {
  return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, name) => {
    assert.ok(Object.hasOwn(values, name), '未知上下文: ' + name);
    return values[name];
  });
}

function runStep(action, name, values, env, cwd) {
  const lines = block(action, name);
  const at = lines.indexOf('      run: |');
  assert.ok(at >= 0);
  const script = lines.slice(at + 1).filter(line => line.startsWith('        ')).map(line => line.slice(8)).join('\n');
  const result = spawnSync('bash', ['-s'], {
    input: 'export PATH="/usr/bin:/bin:$PATH"\n' + render(script, values) + '\n',
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

for (const [event, choice, config] of [
  ['workflow_dispatch', '双配置测试', 'x86_64'],
  ['workflow_dispatch', '双配置测试', 'x86_64_250'],
  ['workflow_dispatch', 'x86_64', 'x86_64'],
  ['workflow_dispatch', 'x86_64_250', 'x86_64_250'],
  ['schedule', '', 'x86_64'],
  ['schedule', '', 'x86_64_250'],
  ['push', '', 'x86_64'],
  ['push', '', 'x86_64_250'],
]) {
  test(event + '/' + (choice || '无手动输入') + ' 向上游传入 ' + config, () => {
    const cwd = path.join(root, String(++count));
    assert.ok(path.resolve(cwd).startsWith(fs.realpathSync(tmp) + path.sep));
    const build = path.join(cwd, 'build/Immortalwrt');
    fs.mkdirSync(path.join(build, 'relevance'), { recursive: true });
    fs.mkdirSync(path.join(build, 'seed'));
    fs.writeFileSync(path.join(build, 'seed', config), 'CONFIG_TARGET_x86=y\n');
    const settings = [
      'SOURCE_CODE="IMMORTALWRT"', 'REPO_BRANCH="openwrt-24.10"', 'CONFIG_FILE="' + config + '"',
      'COMPILATION_INFORMATION="true"', 'INFORMATION_NOTICE="Telegram"', 'KEEP_RELEASES="30"',
      'KEEP_WORKFLOWS="30"', 'UPLOAD_FIRMWARE="true"', 'UPLOAD_RELEASE="false"',
      'CACHEWRTBUILD_SWITCH="true"', 'UPDATE_FIRMWARE_ONLINE="true"',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(build, 'settings.ini'), settings);
    fs.writeFileSync(path.join(build, 'relevance/settings.ini'), settings.replace('INFORMATION_NOTICE="Telegram"', 'INFORMATION_NOTICE="false"') + 'ERRUN_NUMBER=1\n');
    const output = path.join(cwd, 'github-env');
    fs.writeFileSync(output, '');
    const workflow = fs.readFileSync(path.join(repo, '.github/workflows', event === 'push' ? 'compile.yml' : 'Immortalwrt.yml'), 'utf8');
    const caller = block(workflow, '检测密匙/文件/版本').join('\n');
    const reference = caller.match(/^\s*uses:\s*(\S+)/m)[1];
    const action = fs.readFileSync(reference.startsWith('./') ?
      path.join(repo, reference, 'action.yml') : path.join(__dirname, 'fixtures/common/mishi.yml'), 'utf8');
    const withConfig = caller.match(/^\s*config_file:\s*(.*)$/m);
    const inputConfig = withConfig ? render(withConfig[1], { 'matrix.config_file': config }) : '';
    const values = {
      'github.event_name': event, 'github.event.head_commit': event === 'push' ? 'commit' : 'null',
      'github.event.inputs.REPO_BRANCH': 'openwrt-24.10', 'github.event.inputs.CONFIG_FILE': choice,
      'github.event.inputs.INFORMATION_NOTICE': '关闭', 'github.event.inputs.KEEP_WORKFLOWS': '30',
      'github.event.inputs.KEEP_RELEASES': '30', 'github.event.inputs.SSH_ACTION': 'false',
      'github.event.inputs.UPLOAD_FIRMWARE': 'true', 'github.event.inputs.UPLOAD_RELEASE': 'false',
      'github.event.inputs.CACHEWRTBUILD_SWITCH': 'true', 'github.event.inputs.UPDATE_FIRMWARE_ONLINE': 'true',
      'github.repository': 'example/firmware', 'github.actor': 'example', 'github.run_number': '1',
      'github.ref_name': 'main', 'inputs.config_file': inputConfig,
    };
    const env = { GITHUB_WORKSPACE: cwd.replaceAll('\\', '/'), GITHUB_ENV: output.replaceAll('\\', '/'),
      FOLDER_NAME: 'Immortalwrt', GIT_REPOSITORY: 'example/firmware' };
    runStep(action, '判断启动方式和变量', values, env, cwd);
    function exported() {
      return Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map(line => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }));
    }
    const first = exported();
    assert.equal(first.CONFIG_FILE, config, '原始下拉值覆盖了矩阵配置');
    assert.ok(fs.existsSync(first.MYCONFIG_FILE), '必须指向真实 seed');
    assert.equal(first.KEEP_RELEASES, '30');
    runStep(action, '整理缓存和通知的变量', {
      'env.CACHEWRTBUILD_SWITCH': first.CACHEWRTBUILD_SWITCH,
      'env.INFORMATION_NOTICE': first.INFORMATION_NOTICE,
    }, env, cwd);
    assert.equal(exported().INFORMATION_NOTICE, event === 'schedule' ? 'TG' : 'false');
  });
}
