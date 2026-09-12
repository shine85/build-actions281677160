const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const { test, after } = require('node:test');

const repo = path.resolve(__dirname, '..');
const tmp = path.join(repo, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const suite = fs.mkdtempSync(path.join(tmp, 'immortalwrt-build-test-'));
const baseline = process.env.IMMORTALWRT_TEST_BASELINE === '1';
let counter = 0;
const unix = value => value.replaceAll('\\', '/');

after(() => {
  const target = fs.realpathSync(suite);
  assert.ok(target.startsWith(fs.realpathSync(tmp) + path.sep));
  fs.rmSync(target, { recursive: true });
});

function bash(script, args = [], options = {}) {
  return spawnSync('bash', ['-s', '--', ...args.map(unix)], {
    input: 'export PATH="/usr/bin:/bin:$PATH"\n' + script,
    cwd: options.cwd || repo,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
}

function succeed(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

function fixture(config = 'x86_64', overrides = {}) {
  const dir = path.join(suite, String(++counter));
  const common = path.join(dir, 'common');
  const home = path.join(dir, 'openwrt');
  fs.mkdirSync(path.join(common, 'custom'), { recursive: true });
  fs.mkdirSync(path.join(common, 'autoupdate'), { recursive: true });
  fs.mkdirSync(path.join(home, 'package/base-files/files/etc'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/common/upgrade.sh'), path.join(common, 'upgrade.sh'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/common/ubuntu.sh'), path.join(common, 'custom/ubuntu.sh'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/common/common.sh'), path.join(common, 'common.sh'));
  fs.writeFileSync(path.join(common, 'autoupdate/replace'), '');
  const envFile = path.join(dir, 'github-env');
  fs.writeFileSync(envFile, '');
  return {
    dir, common, home, envFile,
    env: {
      FOLDER_NAME: 'Immortalwrt',
      CONFIG_FILE: config,
      LINSHI_COMMON: unix(common),
      HOME_PATH: unix(home),
      GITHUB_WORKSPACE: unix(dir),
      GITHUB_ENV: unix(envFile),
      KEEP_RELEASES: '30',
      KEEP_WORKFLOWS: '30',
      TARGET_BOARD: 'x86',
      TARGET_PROFILE: 'x86-64',
      LUCI_EDITION: '24.10',
      SOURCE: 'Immortalwrt',
      UPGRADE_DATE: config === 'x86_64' ? '1789171739' : '1789171751',
      GITHUB_LINK: 'https://github.com/example/firmware',
      ...overrides,
    },
  };
}

function prepare(f) {
  if (baseline) return;
  succeed(bash('bash "$1"\n', [path.join(repo, 'tools/prepare-immortalwrt.sh')], { env: f.env }));
}

function generate(f) {
  succeed(bash('set -e\nsource "$1"\nDiy_Part2\n', [path.join(f.common, 'upgrade.sh')], { env: f.env }));
  const env = Object.fromEntries(fs.readFileSync(f.envFile, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  return { ...f, env: { ...f.env, ...env }, metadata: fs.readFileSync(path.join(f.home, 'package/base-files/files/etc/openwrt_update'), 'utf8') };
}

test('6 与 250 固件的原始更新匹配规则各自选中正确版本', () => {
  const six = fixture('x86_64');
  const twoFifty = fixture('x86_64_250');
  prepare(six);
  prepare(twoFifty);
  const builds = [generate(six), generate(twoFifty)];
  const index = path.join(suite, 'mixed-releases.json');
  const assets = builds.flatMap(b => ['legacy', 'uefi'].map(boot => ({
    browser_download_url: 'https://github.com/example/firmware/releases/download/' + b.env.UPDATE_TAG + '/' +
      b.env.LUCI_EDITION + '-' + b.env.FIRMWARE_VERSION + '-' + boot + '-abcdef.img.gz',
  })));
  fs.writeFileSync(index, JSON.stringify({ assets }, null, 2));
  for (const [build, expectedVersion] of [[builds[0], '1789171739'], [builds[1], '1789171751']]) {
    for (const boot of ['legacy', 'uefi']) {
      // 执行真实固件 AutoUpdate 的匹配过程，不执行下载或刷写。
      const selected = succeed(bash([
        'set -e',
        'source "$1"',
        'tmpapi_version="$2"',
        'regex="https://.*$LUCI_EDITION-$SOURCE-$DEVICE_MODEL-[0-9]+-$BOOT_TYPE-.*$FIRMWARE_SUFFIX"',
        'target_line=$(grep -E "$regex" "$tmpapi_version" | tail -n 1)',
        'REMOTE_FIRMWARE=$(echo "$target_line" |grep -Eo "$LUCI_EDITION.*$FIRMWARE_SUFFIX")',
        'printf "%s\\n" "$REMOTE_FIRMWARE"',
      ].join('\n'), [path.join(build.home, 'package/base-files/files/etc/openwrt_update'), index],
      { env: { ...build.env, BOOT_TYPE: boot } })).trim();
      assert.ok(selected.includes('-' + expectedVersion + '-' + boot + '-'), build.env.CONFIG_FILE + ' 选错固件: ' + selected);
    }
  }
});

for (const config of ['x86_64', 'x86_64_250']) {
  test(config + ' 的发布通道、固件元数据与清理前缀一致', () => {
    const f = fixture(config);
    prepare(f);
    const build = generate(f);
    const expectedTag = config === 'x86_64' ? 'Update-x86-x86_64' : 'Update-x86-x86_64_250';
    assert.equal(build.env.UPDATE_TAG, expectedTag);
    const settings = succeed(bash('source "$1"\nprintf "%s\\n%s\\n" "$DEVICE_MODEL" "$RELEASE_DOWNLOAD"\n',
      [path.join(f.home, 'package/base-files/files/etc/openwrt_update')])).trim().split('\n');
    assert.deepEqual(settings, ['x86-64-' + config, 'https://github.com/example/firmware/releases/download/' + expectedTag]);
    const cleanup = succeed(bash('source "$1"\nprintf "%s\\n%s\\n" "$UPDATE_TAG" "$FIRMWARE_PROFILEER"\n',
      [path.join(f.dir, 'del_assets')])).trim().split('\n');
    assert.deepEqual(cleanup, [expectedTag, '24.10-Immortalwrt-x86-64-' + config]);
  });

  test(config + ' 的真实打包逻辑生成可区分的 Legacy 与 UEFI 资产', () => {
    const f = fixture(config);
    prepare(f);
    const build = generate(f);
    const firmwarePath = path.join(f.home, 'bin/targets/x86/64');
    fs.mkdirSync(firmwarePath, { recursive: true });
    for (const suffix of ['combined', 'combined-efi']) {
      fs.writeFileSync(path.join(firmwarePath, 'openwrt-x86-64-generic-squashfs-' + suffix + '.img.gz'), gzipSync('fixture-' + config));
    }
    succeed(bash('set -e\nsource "$1"\nDiy_Part3\n', [path.join(f.common, 'upgrade.sh')], {
      env: { ...build.env, FIRMWARE_PATH: unix(firmwarePath) },
    }));
    const files = fs.readdirSync(path.join(f.home, 'bin/Firmware')).sort();
    assert.equal(files.length, 2);
    for (const boot of ['legacy', 'uefi']) {
      assert.ok(files.some(name => name.startsWith('24.10-Immortalwrt-x86-64-' + config + '-') && name.includes('-' + boot + '-')), files.join(', '));
    }
  });
}

test('依赖安装保留尾段包且不再请求失效的额外依赖列表', () => {
  const f = fixture();
  prepare(f);
  const source = fs.readFileSync(path.join(f.common, 'custom/ubuntu.sh'), 'utf8');
  const installBlock = source.slice(source.indexOf('# 安装编译openwrt的依赖'), source.indexOf('# 安装gcc g++'));
  const installed = succeed(bash([
    'set -e',
    'apt-get() { if [[ "$1" == install && "$#" -le 2 ]]; then printf "安装请求缺少包名\\n" >&2; return 98; fi; printf "%s\\n" "$@"; }',
    'snap() { :; }',
    'curl() { printf "不应额外下载依赖列表\\n" >&2; return 22; }',
    installBlock,
  ].join('\n'), [], { env: f.env })).split('\n');
  for (const name of ['python3-setuptools', 'python3-distutils', 'python3-netifaces', 'qemu-utils', 'rsync', 'squashfs-tools', 'swig', 'zlib1g-dev']) {
    assert.ok(installed.includes(name), '未安装依赖: ' + name);
  }
});

test('定时配置为清理动作提供有效保留数', () => {
  const output = succeed(bash('set -e\nsource "$1"\nprintf "%s\\n%s\\n" "$KEEP_RELEASES" "$KEEP_WORKFLOWS"\n',
    [path.join(repo, 'build/Immortalwrt/settings.ini')])).split('\n');
  assert.match(output[0], /^(0|[1-9][0-9]*)$/);
  assert.match(output[1], /^(0|[1-9][0-9]*)$/);
});

for (const key of ['KEEP_RELEASES', 'KEEP_WORKFLOWS']) {
  for (const value of ['', '-1', 'abc', '08']) {
    test(key + '=' + JSON.stringify(value) + ' 在修改上游脚本前明确失败', { skip: baseline }, () => {
      const f = fixture('x86_64', { [key]: value });
      const before = fs.readFileSync(path.join(f.common, 'upgrade.sh'));
      const result = bash('bash "$1"\n', [path.join(repo, 'tools/prepare-immortalwrt.sh')], { env: f.env });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(key), result.stderr);
      assert.deepEqual(fs.readFileSync(path.join(f.common, 'upgrade.sh')), before);
    });
  }
}

test('源码补丁失败会中止后续准备操作', () => {
  const f = fixture();
  prepare(f);
  const source = fs.readFileSync(path.join(f.common, 'common.sh'), 'utf8');
  const start = source.indexOf('if [ -d "${BUILD_PATCHES}" ]; then');
  const end = source.indexOf('if [ -d "${BUILD_DIY}" ]; then', start);
  assert.ok(start >= 0 && end > start);
  const patches = path.join(f.dir, 'source-patches');
  fs.mkdirSync(patches);
  fs.writeFileSync(path.join(patches, 'broken.patch'), 'invalid patch\n');
  const result = bash(source.slice(start, end) + '\nprintf "unexpected-continue\\n"\n', [], {
    cwd: f.home,
    env: { ...f.env, BUILD_PATCHES: unix(patches) },
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, '上游忽略了源码补丁错误\n' + result.stdout + result.stderr + source.slice(start, end));
  assert.ok(!result.stdout.includes('unexpected-continue'));
});

test('保留数为零仍是有效的显式配置', () => {
  const f = fixture('x86_64', { KEEP_RELEASES: '0', KEEP_WORKFLOWS: '0' });
  prepare(f);
});

test('上游上下文不匹配时整份补丁不写入任何文件', () => {
  if (baseline) return;
  const f = fixture();
  const ubuntu = path.join(f.common, 'custom/ubuntu.sh');
  fs.writeFileSync(ubuntu, '# different upstream\n');
  const before = fs.readFileSync(path.join(f.common, 'upgrade.sh'));
  const result = bash('bash "$1"\n', [path.join(repo, 'tools/prepare-immortalwrt.sh')], { env: f.env });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.common, 'upgrade.sh')), before);
  assert.equal(fs.readFileSync(ubuntu, 'utf8'), '# different upstream\n');
});

test('缺少配置标识时不生成可发布的更新元数据', () => {
  const f = fixture('', { CONFIG_FILE: '' });
  prepare(f);
  const result = bash('source "$1"\nDiy_Part2\n', [path.join(f.common, 'upgrade.sh')], { env: f.env });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.ok(!fs.existsSync(path.join(f.home, 'package/base-files/files/etc/openwrt_update')));
});

function workflowRun(name) {
  const source = fs.readFileSync(path.join(repo, '.github/workflows/compile.yml'), 'utf8').replace(/\r\n/g, '\n');
  const marker = '    - name: ' + name + '\n';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, '缺少步骤: ' + name);
  const next = source.indexOf('    - name:', start + marker.length);
  const block = source.slice(start, next < 0 ? source.length : next);
  const lines = block.slice(block.indexOf('      run: |\n') + 13).split('\n');
  return lines.filter(line => line.startsWith('        ')).map(line => line.slice(8)).join('\n')
    .replaceAll('${{ env.COMMON_SH }}', '$COMMON_SH');
}

test('实际整理步骤传播镜像复制失败', () => {
  const f = fixture();
  prepare(f);
  const build = generate(f);
  const firmwarePath = path.join(f.home, 'bin/targets/x86/64');
  fs.mkdirSync(firmwarePath, { recursive: true });
  fs.mkdirSync(path.join(f.home, 'bin/packages'), { recursive: true });
  for (const suffix of ['combined', 'combined-efi']) {
    fs.writeFileSync(path.join(firmwarePath, 'openwrt-x86-64-generic-squashfs-' + suffix + '.img.gz'), gzipSync('fixture'));
  }
  const clearPath = path.join(f.dir, 'clear.txt');
  fs.writeFileSync(clearPath, '');
  const script = 'cp() { return 42; }\nexport -f cp\n' + workflowRun('整理固件文件夹(需配合diy-part.sh设定使用)');
  const result = bash(script, [], {
    cwd: f.dir,
    env: { ...build.env, BENDI_VERSION: '2', COMMON_SH: unix(path.join(f.common, 'common.sh')),
      UPGRADE_SH: unix(path.join(f.common, 'upgrade.sh')), FIRMWARE_PATH: unix(firmwarePath), CLEAR_PATH: unix(clearPath),
      UPDATE_FIRMWARE_ONLINE: 'true', GUJIAN_DATE: '09.12', LINUX_KERNEL: '6.6.151' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 42, result.stderr + result.stdout);
});

test('无可发布镜像时打包明确失败', () => {
  const f = fixture();
  prepare(f);
  const build = generate(f);
  const firmwarePath = path.join(f.home, 'bin/targets/x86/64');
  fs.mkdirSync(firmwarePath, { recursive: true });
  const result = bash('set -e\nsource "$1"\nDiy_Part3\n', [path.join(f.common, 'upgrade.sh')],
    { env: { ...build.env, FIRMWARE_PATH: unix(firmwarePath) } });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
});

test('APT 更新失败不会跳过安装后继续执行', () => {
  const f = fixture();
  prepare(f);
  const source = fs.readFileSync(path.join(f.common, 'custom/ubuntu.sh'), 'utf8');
  const start = source.indexOf('apt-get update -y && apt-get install -y yarn gh');
  const fixedStart = source.indexOf('apt-get update -y\napt-get install -y yarn gh');
  const line = start >= 0 ? 'apt-get update -y && apt-get install -y yarn gh' :
    source.slice(fixedStart, source.indexOf('\n\n', fixedStart));
  assert.ok(start >= 0 || fixedStart >= 0);
  const result = bash('set -e\napt-get() { [[ "$1" != update ]] || return 43; }\n' + line + '\nprintf "unexpected-continue\\n"\n');
  assert.ifError(result.error);
  assert.equal(result.status, 43, result.stderr + result.stdout);
  assert.ok(!result.stdout.includes('unexpected-continue'));
});
