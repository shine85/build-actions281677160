const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { test, before, after } = require('node:test');
const { configure, readSettings } = require('../tools/immortalwrt-network.cjs');

const { values } = parseArgs({ options: { port: { type: 'string' }, version: { type: 'string' }, 'known-hosts': { type: 'string' } } });
assert.match(values.port || '', /^\d+$/);
assert.ok(['23.05', '24.10', '25.12'].includes(values.version));
assert.ok(values['known-hosts']);
const repo = path.resolve(__dirname, '..');
const root = '/tmp/immortalwrt-network-test-' + crypto.randomBytes(6).toString('hex');
const sshArgs = ['-F', 'none', '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=none', '-o', 'PubkeyAuthentication=no',
  '-o', 'PasswordAuthentication=no', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + path.resolve(values['known-hosts']),
  '-o', 'ConnectTimeout=8', '-p', values.port, 'root@127.0.0.1'];

function remote(command, input = '') {
  const result = spawnSync(process.platform === 'win32' ? 'ssh.exe' : 'ssh', [...sshArgs, command], {
    input, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}
function success(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}
function shell(script) { return success(remote('sh -s', script)); }
function upload(file, data) { success(remote('cat > ' + root + '/' + file, data)); }

const helper = fs.readFileSync(path.join(repo, 'tools/immortalwrt-lan-defaults.sh'), 'utf8');
before(() => {
  shell(`set -e
mkdir -p '${root}/bin' '${root}/sbin' '${root}/lib' '${root}/usr/bin' '${root}/usr/lib' '${root}/usr/share' '${root}/etc/config' '${root}/tmp' '${root}/dev'
touch '${root}/dev/null'
mount --bind /dev/null '${root}/dev/null'
cp -a /rom/bin/. '${root}/bin/'
for applet in /rom/usr/bin/*; do
 if [ -L "$applet" ]; then cp -a "$applet" '${root}/usr/bin/'; fi
done
cp -a /rom/sbin/uci '${root}/sbin/'
cp -a /rom/usr/bin/jshn '${root}/usr/bin/'
cp -a /rom/lib/*.so* '${root}/lib/'
cp -a /rom/usr/lib/*.so* '${root}/usr/lib/'
cp -a /rom/lib/functions* '${root}/lib/'
cp -a /rom/usr/share/libubox '${root}/usr/share/'
`);
  upload('lan-defaults.sh', helper);
});
const source = fs.readFileSync(path.join(__dirname, 'fixtures/network/config_generate-' + values.version + '.sh'), 'utf8');

after(() => {
  assert.match(root, /^\/tmp\/immortalwrt-network-test-[a-f0-9]{12}$/);
  success(remote('umount ' + root + '/dev/null'));
  success(remote('rm -rf ' + root));
});

function reset(board = { network: { lan: { device: 'eth0', protocol: 'static' }, wan: { device: 'eth1', protocol: 'dhcp' } } }) {
  shell(`set -e
rm -f '${root}/etc/config/network' '${root}/etc/config/system' '${root}/etc/config/ttyd'
rm -rf '${root}/tmp/.uci'
cp /rom/etc/config/dhcp '${root}/etc/config/dhcp'
`);
  upload('etc/board.json', JSON.stringify(board));
}

function diy(config, replacements = {}) {
  let text = fs.readFileSync(path.join(repo, 'build/Immortalwrt', config === 'x86_64' ? 'diy-part.sh' : 'diy-part-250.sh'), 'utf8');
  for (const [key, value] of Object.entries(replacements)) text = text.replace(new RegExp('^(export ' + key + '=")[^"]*(")', 'm'), (_, before, after) => before + value + after);
  return text;
}

function generate(config = 'x86_64_250', replacements = {}) {
  upload('config_generate', configure(source, readSettings(diy(config, replacements)), helper));
  return remote('chroot ' + root + ' /bin/sh /config_generate');
}

function inspect() {
  return JSON.parse(success(remote('chroot ' + root + ' /bin/sh -s', `. /usr/share/libubox/jshn.sh
json_init
for key in network.lan.ipaddr network.lan.netmask network.lan.gateway network.lan.dns network.lan.device dhcp.lan.ignore; do
 if value=$(uci -q get "$key"); then json_add_string "$key" "$value"; else json_add_string "$key" '<unset>'; fi
done
json_add_array bridges
for section in $(uci -X show network | sed -n 's/^network\\.\\([a-zA-Z0-9_]*\\)=device$/\\1/p'); do
 [ "$(uci -q get network.$section.type)" != bridge ] || json_add_string '' "$(uci -q get network.$section.name)"
done
json_close_array
json_dump
`)));
}

for (const [config, ip, gateway] of [['x86_64', '192.168.6.2', '192.168.6.1'], ['x86_64_250', '192.168.250.2', '192.168.250.1']]) {
  test(values.version + ' / ' + config + ' 使用真实 UCI 生成正确旁路由网络', () => {
    reset();
    success(generate(config));
    const actual = inspect();
    assert.equal(actual['network.lan.ipaddr'], ip + (values.version === '25.12' ? '/24' : ''));
    if (values.version !== '25.12') assert.equal(actual['network.lan.netmask'], '255.255.255.0');
    assert.equal(actual['network.lan.gateway'], gateway);
    assert.equal(actual['network.lan.dns'], '223.5.5.5');
    assert.equal(actual['dhcp.lan.ignore'], '1');
    assert.equal(actual['network.lan.device'], 'eth0');
    assert.deepEqual(actual.bridges, []);
    assert.notEqual(remote('test -e ' + root + '/etc/config/ttyd').status, 0);
  });
}

test('多 DNS 与非 /24 掩码按实际配置生效', () => {
  reset();
  success(generate('x86_64', { Ipv4_ipaddr: '192.168.7.2', Netmask_netm: '255.255.254.0', DNS_Settings: '223.5.5.5 1.1.1.1' }));
  const actual = inspect();
  assert.equal(actual['network.lan.ipaddr'], values.version === '25.12' ? '192.168.7.2/23' : '192.168.7.2');
  assert.equal(actual['network.lan.dns'], '223.5.5.5 1.1.1.1');
});

test('已有网络配置保留，补生成 system 时不重设用户网络', () => {
  reset();
  const network = "config interface 'lan'\n option device 'custom0'\n option proto 'static'\n option ipaddr '10.77.0.9'\n option netmask '255.255.255.0'\n option gateway '10.77.0.1'\n";
  upload('etc/config/network', network);
  success(generate());
  assert.equal(success(remote('cat ' + root + '/etc/config/network')), network);
});

for (const [label, ports, other] of [
  ['多端口桥', ['eth0', 'eth2'], ''],
  ['共享桥', ['eth0'], "config interface 'other'\n option device 'br-test'\n"],
  ['桥接 VLAN', ['eth0'], "config bridge-vlan 'vlan1'\n option device 'br-test'\n option vlan '1'\n"],
]) {
  test(label + '明确失败且不改动原网络关系', () => {
    reset();
    const network = "config interface 'lan'\n option device 'br-test'\n option proto 'static'\n" +
      "config device 'first_unrelated'\n option name 'elsewhere'\n option type 'bridge'\n list ports 'eth9'\n" +
      "config device 'selected_bridge'\n option name 'br-test'\n option type 'bridge'\n" + ports.map(port => " list ports '" + port + "'\n").join('') + other;
    upload('etc/config/network', network);
    const before = success(remote('chroot ' + root + ' /sbin/uci export network'));
    const result = remote('chroot ' + root + ' /bin/sh -s', ". /lan-defaults.sh\nimmortalwrt_apply_lan_defaults '192.168.250.1' '223.5.5.5' '0' '1' '1' '1'\n");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, label === '多端口桥' ? /多个桥接端口/ : /其他接口或 VLAN/);
    assert.equal(success(remote('chroot ' + root + ' /sbin/uci export network')), before);
  });
}

test('真实 UCI 写入失败会中止生成器', () => {
  reset();
  upload('etc/config/dhcp', "config dnsmasq\n option domainneeded '1'\n");
  const result = generate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uci: Invalid argument/);
});
