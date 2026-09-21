const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, after } = require('node:test');

const repo = path.resolve(__dirname, '..');
const temporary = path.join(repo, 'tmp');
fs.mkdirSync(temporary, { recursive: true });
const suite = fs.mkdtempSync(path.join(temporary, 'immortalwrt-plugins-test-'));
after(() => {
  const resolved = fs.realpathSync(suite);
  assert.ok(resolved.startsWith(fs.realpathSync(temporary) + path.sep));
  fs.rmSync(resolved, { recursive: true });
});
let sequence = 0;
const kucat = ['luci-theme-kucat', 'luci-app-kucat-config', 'luci-i18n-kucat-config-zh-cn'];
const lines = packages => packages.map(name => 'CONFIG_PACKAGE_' + name + '=y').join('\n') + '\n';

function fixture() {
  const root = path.join(suite, String(++sequence));
  const home = path.join(root, 'openwrt');
  const seed = path.join(root, 'build/Immortalwrt/seed/x86_64');
  fs.mkdirSync(path.dirname(seed), { recursive: true });
  fs.mkdirSync(home);
  const acl = path.join(home, 'package/luci-theme-kucat/root/usr/share/rpcd/acl.d/luci-theme-kucat.json');
  fs.mkdirSync(path.dirname(acl), { recursive: true });
  fs.writeFileSync(acl, '{"luci-theme-kucat":{"read":{"uci":["kucat"]}}}\n');
  fs.writeFileSync(seed, lines(['luci-app-frpc', 'luci-app-homeproxy', 'luci-app-kucat-config']));
  fs.writeFileSync(path.join(home, '.config'), lines(['luci-app-frpc', 'luci-app-homeproxy']));
  const output = path.join(root, 'config.txt');
  fs.writeFileSync(output, 'previous-seed\n');
  return { root, home, seed, output, acl, env: { GITHUB_WORKSPACE: root, HOME_PATH: home, FOLDER_NAME: 'Immortalwrt', CONFIG_FILE: 'x86_64', CONFIG_TXT: output } };
}

function invoke(f, options = {}) {
  return require('../tools/immortalwrt-plugins.cjs').ensurePlugins({ env: f.env, ...options });
}

test('请求的插件被 defconfig 取消时明确失败，不能写回缺包 seed', () => {
  const f = fixture();
  const original = fs.readFileSync(f.seed);
  const run = (file) => {
    assert.equal(file, 'make');
    fs.writeFileSync(path.join(f.home, '.config'), lines([...kucat, 'luci-app-homeproxy']));
    return { status: 0 };
  };
  assert.throws(() => invoke(f, { updateSeed: true, run }), /luci-app-frpc/);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'previous-seed\n');
  assert.deepEqual(fs.readFileSync(f.seed), original);
});

test('补回 kucat 后重新解析配置，生成 seed 保留用户的显式插件请求', () => {
  const f = fixture();
  let calls = 0;
  const run = (file, args, options) => {
    assert.equal(options.cwd, f.home);
    calls++;
    if (file === 'make') {
      assert.deepEqual(args, ['defconfig']);
      const config = fs.readFileSync(path.join(f.home, '.config'), 'utf8');
      for (const name of kucat) assert.ok(config.includes('CONFIG_PACKAGE_' + name + '=y'));
      return { status: 0 };
    }
    assert.equal(file, 'bash');
    assert.equal(path.basename(args[0]), 'diffconfig.sh');
    // diffconfig 会省略已变成依赖的插件，用户的请求仍须保留。
    return { status: 0, stdout: 'CONFIG_TARGET_x86=y\n' };
  };
  const result = invoke(f, { updateSeed: true, run });
  assert.equal(calls, 2);
  for (const name of [...kucat, 'luci-app-frpc', 'luci-app-homeproxy']) {
    assert.ok(result.includes(name));
    assert.ok(fs.readFileSync(f.output, 'utf8').includes('CONFIG_PACKAGE_' + name + '=y'));
  }
});

test('编译阶段不写回 seed，损坏的 operates 副本不能掩盖仓库原始请求', () => {
  const f = fixture();
  f.env.MYCONFIG_FILE = path.join(f.root, 'already-modified-seed');
  fs.writeFileSync(f.env.MYCONFIG_FILE, lines(kucat));
  assert.throws(() => invoke(f, { run: () => {
    fs.writeFileSync(path.join(f.home, '.config'), lines(kucat));
    return { status: 0 };
  } }), /luci-app-frpc.*luci-app-homeproxy/);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'previous-seed\n');
});

test('defconfig 或 diffconfig 失败时终止，保留原输出', () => {
  for (const failed of ['make', 'bash']) {
    const f = fixture();
    assert.throws(() => invoke(f, { updateSeed: true, run: file => ({ status: file === failed ? 42 : 0, stdout: '', stderr: 'underlying failure detail' }) }), /失败[\s\S]*underlying failure detail/);
    assert.equal(fs.readFileSync(f.output, 'utf8'), 'previous-seed\n');
  }
});

test('在构建之前修复上游 kucat ACL 的多余括号，保留原权限且重复执行无变化', () => {
  const f = fixture();
  fs.copyFileSync(path.join(__dirname, 'fixtures/kucat-acl.invalid.json'), f.acl);
  const original = fs.readFileSync(f.acl, 'utf8');
  assert.throws(() => JSON.parse(original), SyntaxError);
  const run = () => {
    const acl = JSON.parse(fs.readFileSync(f.acl, 'utf8'));
    assert.deepEqual(acl['luci-theme-kucat'].read.uci, ['kucat']);
    assert.deepEqual(acl['luci-theme-kucat'].write.uci, ['kucat']);
    assert.deepEqual(acl['luci-theme-kucat'].read.file['/usr/libexec/rpcd/luci.kucatget'], ['exec']);
    return { status: 0 };
  };
  invoke(f, { run });
  const repaired = fs.readFileSync(f.acl, 'utf8');
  assert.equal(repaired.length, original.length - 2);
  invoke(f, { run });
  assert.equal(fs.readFileSync(f.acl, 'utf8'), repaired);
});

test('双配置 seed 显式关闭 qmodem，请求列表不含未勾选插件', () => {
  const { requestedPlugins } = require('../tools/immortalwrt-plugins.cjs');
  for (const name of ['x86_64', 'x86_64_250']) {
    const seed = fs.readFileSync(path.join(repo, 'build/Immortalwrt/seed', name), 'utf8');
    assert.match(seed, /# CONFIG_PACKAGE_luci-app-qmodem is not set/);
    assert.match(seed, /# CONFIG_PACKAGE_luci-app-qmodem-next is not set/);
    assert.deepEqual(requestedPlugins(seed).filter(item => /^luci-app-[a-z0-9-]+$/.test(item)), [
      'luci-app-autoreboot', 'luci-app-frpc', 'luci-app-homeproxy', 'luci-app-kucat-config', 'luci-app-nikki',
    ]);
  }
});

test('defconfig 自动勾上的 luci-app 必须关掉，不能编进固件', () => {
  const f = fixture();
  let makes = 0;
  const run = (file) => {
    if (file !== 'make') return { status: 0 };
    makes++;
    const configPath = path.join(f.home, '.config');
    const config = fs.readFileSync(configPath, 'utf8');
    if (makes === 1) {
      fs.writeFileSync(configPath, config + lines(['luci-app-qmodem-next', 'luci-i18n-qmodem-next-zh_Hans', 'luci-app-firewall']));
      return { status: 0 };
    }
    assert.match(config, /# CONFIG_PACKAGE_luci-app-qmodem-next is not set/);
    assert.match(config, /# CONFIG_PACKAGE_luci-i18n-qmodem-next-zh_Hans is not set/);
    assert.doesNotMatch(config, /^CONFIG_PACKAGE_luci-app-qmodem-next=y/m);
    fs.writeFileSync(configPath, config.replace('# CONFIG_PACKAGE_luci-app-firewall is not set', 'CONFIG_PACKAGE_luci-app-firewall=y'));
    return { status: 0 };
  };
  const result = invoke(f, { run });
  assert.equal(makes, 2);
  assert.ok(!result.includes('luci-app-qmodem-next'));
  const final = fs.readFileSync(path.join(f.home, '.config'), 'utf8');
  assert.match(final, /^CONFIG_PACKAGE_luci-app-firewall=y/m);
  assert.doesNotMatch(final, /^CONFIG_PACKAGE_luci-app-qmodem-next=y/m);
});

test('第二轮 defconfig 仍勾上未请求插件时必须失败', () => {
  const f = fixture();
  let makes = 0;
  const run = () => {
    makes++;
    const configPath = path.join(f.home, '.config');
    const config = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, config + lines(['luci-app-qmodem-next', ...kucat, 'luci-app-frpc', 'luci-app-homeproxy']));
    return { status: 0 };
  };
  assert.throws(() => invoke(f, { run }), /未请求的插件|qmodem-next/);
  assert.equal(makes, 2);
});

test('合法 ACL 保持原样，未知损坏不能被当作已知上游问题自动改写', () => {
  const f = fixture();
  const original = fs.readFileSync(f.acl, 'utf8');
  invoke(f, { run: () => ({ status: 0 }) });
  assert.equal(fs.readFileSync(f.acl, 'utf8'), original);
  const malformed = '{"unexpected":true}}\n';
  fs.writeFileSync(f.acl, malformed);
  assert.throws(() => invoke(f, { run: () => ({ status: 0 }) }), /kucat.*ACL/);
  assert.equal(fs.readFileSync(f.acl, 'utf8'), malformed);
});
