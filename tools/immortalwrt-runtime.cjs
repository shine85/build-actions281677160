const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify, parseArgs } = require('node:util');
const { readSettings } = require('./immortalwrt-network.cjs');
const { validateObservation, sha256 } = require('./immortalwrt-verification.cjs');
const { checkPlugins } = require('./immortalwrt-plugin-runtime.cjs');

const execute = promisify(execFile);
const BOOT_TIMEOUT_MS = 8 * 60 * 1000;
const STABLE_UPTIME_SECONDS = 75;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const check = (condition, message) => { if (!condition) throw new Error(message); };

async function command(file, args, input = '', timeout = 30000) {
  const pending = execute(file, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  pending.child.stdin.end(input);
  return pending;
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

function vmNetwork(settings, generator) {
  const address = settings.address === '0' ? generator.match(/lan\)\s+ipad=\$\{ipaddr:-"([^"]+)"\}/)?.[1] : settings.address;
  const netmask = settings.netmask === '0' ? generator.match(/netm=\$\{netmask:-"([^"]+)"\}/)?.[1] : settings.netmask;
  check(address && netmask, '无法确定隔离虚拟机的默认网络');
  const ip = address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  const mask = netmask.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  const network = (ip & mask) >>> 0;
  const prefix = mask.toString(2).replace(/0/g, '').length;
  const format = n => [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.');
  const host = format(network + (ip === network + 1 ? 2 : 1));
  return { address, host, subnet: format(network) + '/' + prefix };
}

function serviceState(value, name) {
  return { instances: Object.fromEntries(Object.entries(value[name]?.instances || {}).map(([key, item]) =>
    [key, { running: item.running === true }])) };
}

async function inspectLuci(port) {
  const origin = 'http://127.0.0.1:' + port;
  let target = '/cgi-bin/luci/';
  let response;
  for (let i = 0; i < 5; i++) {
    response = await fetch(origin + target, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const redirect = new URL(response.headers.get('location'), origin + target);
    check(redirect.origin === origin, 'LuCI 重定向离开了隔离测试地址');
    target = redirect.pathname + redirect.search;
  }
  const html = await response.text();
  const loginForm = /<form\b/.test(html) && /(?:luci_password|type=["']password)/.test(html) && !/Runtime error|Internal Server Error/.test(html);
  const asset = html.match(/["'](\/luci-static\/kucat\/[^"'<>]+\.css(?:\?[^"'<>]*)?)["']/)?.[1];
  let themeAsset = false;
  if (asset) {
    const css = await fetch(origin + asset.replaceAll('&amp;', '&'), { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    themeAsset = css.status === 200 && (await css.text()).length > 0;
  }
  return { status: response.status, loginForm, themeAsset };
}

async function bootAndObserve({ baseImage, boot, settings, generator, work, qemu, qemuImg, qemuData, ovmfCode, ovmfVars }) {
  const [sshPort, httpPort] = await Promise.all([freePort(), freePort()]);
  const ssh = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
  const keygen = process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen';
  const key = path.join(work, 'test-key');
  await command(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'isolated-firmware-check', '-f', key]);
  const publicKey = (await fs.promises.readFile(key + '.pub', 'utf8')).trim();
  const format = JSON.parse((await command(qemuImg, ['info', '--output=json', baseImage])).stdout).format;
  check(['raw', 'qcow2'].includes(format), '无法启动此镜像格式: ' + format);
  const overlay = path.join(work, 'test.qcow2');
  await command(qemuImg, ['create', '-f', 'qcow2', '-F', format, '-b', baseImage, overlay]);
  const network = vmNetwork(settings, generator);
  const args = ['-machine', 'pc,accel=tcg', '-cpu', 'max', '-m', '512', '-smp', '2', '-display', 'none', '-serial', 'stdio', '-monitor', 'none'];
  if (qemuData) args.push('-L', qemuData);
  if (boot === 'uefi') {
    check(ovmfCode && ovmfVars, '缺少 UEFI 验证固件');
    const variables = path.join(work, 'uefi-vars.fd');
    await fs.promises.copyFile(ovmfVars, variables);
    args.push('-drive', 'if=pflash,format=raw,readonly=on,file=' + ovmfCode.replaceAll('\\', '/'),
      '-drive', 'if=pflash,format=raw,file=' + variables.replaceAll('\\', '/'));
  }
  args.push('-drive', 'file=' + overlay.replaceAll('\\', '/') + ',format=qcow2,if=ide', '-net', 'none',
    '-netdev', 'user,id=lan,net=' + network.subnet + ',host=' + network.host + ',restrict=on,hostfwd=tcp:127.0.0.1:' + sshPort + '-' + network.address + ':22,hostfwd=tcp:127.0.0.1:' + httpPort + '-' + network.address + ':80',
    '-device', 'e1000,netdev=lan,romfile=', '-device', 'e1000,id=wan,romfile=');
  const vm = spawn(qemu, args, { cwd: work, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let serial = '', kernelBoots = 0, activatedBoot = 0, provisionedBoot = 0, keyReadyBoot = 0;
  let vmError = '', serialQueue = Promise.resolve();
  const nonce = 'IMMORTALWRT_READY_' + crypto.randomBytes(12).toString('hex');
  const stopped = new Promise(resolve => { vm.once('exit', (code, signal) => resolve({ code, signal })); vm.once('error', error => { vmError = error.message; resolve({ error: error.message }); }); });
  vm.stdin.on('error', error => { vmError = error.message; });
  const sendSerial = text => {
    const targetBoot = kernelBoots;
    serialQueue = serialQueue.then(async () => {
      // 启动时 UART 的 FIFO 很小，整行突发写入会丢字符。
      for (const character of text) {
        if (vm.exitCode !== null || vm.signalCode !== null || targetBoot !== kernelBoots) return;
        vm.stdin.write(character);
        await pause(8);
      }
    }).catch(error => { vmError = error.message; });
  };
  for (const stream of [vm.stdout, vm.stderr]) stream.on('data', chunk => {
    serial += chunk.toString('utf8');
    kernelBoots = (serial.match(/\[\s*0\.000000\] Linux version /g) || []).length;
    const current = serial.slice(serial.lastIndexOf('Linux version'));
    if (current.includes('Please press Enter') && activatedBoot < kernelBoots) {
      activatedBoot = kernelBoots; sendSerial('\n');
    }
    const plain = current.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (/root@[^\r\n#]+#/.test(plain) && provisionedBoot < kernelBoots) {
      provisionedBoot = kernelBoots;
      sendSerial('mkdir -p /etc/dropbear && { grep -qxF ' + quote(publicKey) + ' /etc/dropbear/authorized_keys 2>/dev/null || printf \'%s\\n\' ' + quote(publicKey) + ' >> /etc/dropbear/authorized_keys; } && chmod 600 /etc/dropbear/authorized_keys && printf \'\\n' + nonce + '\\n\'\n');
    }
    if (new RegExp('(?:^|[\\r\\n])' + nonce + '[\\r\\n]').test(current)) keyReadyBoot = kernelBoots;
  });
  const sshArgs = ['-F', 'none', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(work, 'known-hosts'), '-o', 'ConnectTimeout=3',
    '-p', String(sshPort), 'root@127.0.0.1'];
  const remote = (script, timeout = 30000) => command(ssh, [...sshArgs, 'sh -s'], script, timeout);
  let ready = false, expectedBoots = 1, lastFailure = '', noticeAt = 0;
  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      check(!vmError, '虚拟机或串口异常: ' + vmError);
      check(vm.exitCode === null && vm.signalCode === null, '虚拟机在完成验收前退出');
      if (keyReadyBoot === kernelBoots && keyReadyBoot > 0) {
        try {
          const state = await remote('printf "%s\\n" "$(cut -d. -f1 /proc/uptime)" "$(test -e /etc/scripts_reboot && echo 1 || echo 0)" "$(test -e /rom/etc/rc.d/S99restart_scripts && grep -Eq \'(^[[:space:]]*|&&[[:space:]]*)reboot([[:space:]]|$)\' /rom/etc/scripts_reboot && echo 1 || echo 0)"\n');
          const [uptime, pendingReboot, factoryReboot] = state.stdout.trim().split(/\r?\n/);
          if (factoryReboot === '1') expectedBoots = 2;
          if (pendingReboot === '0' && kernelBoots >= expectedBoots && Number(uptime) >= STABLE_UPTIME_SECONDS) { ready = true; break; }
        } catch (error) { lastFailure = String(error.stderr || error.message); }
      }
      if (Date.now() - noticeAt > 15000) { console.log(JSON.stringify({ boot, phase: '等待固件启动', kernelBoots, expectedBoots, provisionedBoot, keyReadyBoot })); noticeAt = Date.now(); }
      await pause(2500);
    }
    check(ready, '固件启动或测试连接未就绪: ' + lastFailure + '；内核启动次数=' + kernelBoots + '，测试连接准备次数=' + keyReadyBoot);
    check(!/Kernel panic|BUG: unable to handle kernel/.test(serial), '启动期间出现内核错误');
    const probe = await fs.promises.readFile(path.join(__dirname, 'immortalwrt-runtime-probe.sh'), 'utf8');
    const raw = JSON.parse((await remote(probe)).stdout);
    const observed = { board: JSON.parse(raw.board_json), lan: JSON.parse(raw.lan_json), uci: raw.uci,
      bridges: raw.bridges, links: raw.links, startupComplete: raw.startupComplete, firewallLanNetworks: raw.firewallLanNetworks,
      packages: raw.packages, efi: raw.efi,
      services: { dnsmasq: serviceState(JSON.parse(raw.dnsmasq_json), 'dnsmasq'), uhttpd: serviceState(JSON.parse(raw.uhttpd_json), 'uhttpd') },
      luci: await inspectLuci(httpPort), kernelBoots };
    await fs.promises.writeFile(path.join(work, 'observed.json'), JSON.stringify(observed, null, 2) + '\n');
    console.log(JSON.stringify({ boot, phase: '验收插件本机功能与页面' }));
    observed.pluginRuntime = await checkPlugins({ remote, origin: 'http://127.0.0.1:' + httpPort, packages: observed.packages });
    await fs.promises.writeFile(path.join(work, 'observed.json'), JSON.stringify(observed, null, 2) + '\n');
    return observed;
  } finally {
    if (ready && vm.exitCode === null) {
      try { await remote('poweroff\n', 10000); } catch (error) { console.log('测试虚拟机关闭连接: ' + String(error.code)); }
    }
    const result = await Promise.race([stopped, pause(5000).then(() => null)]);
    if (!result && vm.exitCode === null && vm.signalCode === null) vm.kill();
    await stopped;
    await fs.promises.writeFile(path.join(work, 'serial.log'), serial.replaceAll(publicKey, '[临时测试公钥]'));
  }
}

async function verifyFirmware({ env = process.env, ...options } = {}) {
  const directory = path.resolve(options.directory || env.FIRMWARE_PATH || '');
  const config = options.config || env.CONFIG_FILE;
  const diy = options.diy || env.DIY_PT2_SH;
  const output = options.report || env.IMMORTALWRT_RUNTIME_REPORT;
  check(config && diy && output && (options.directory || env.FIRMWARE_PATH), '缺少固件验收参数');
  const reportPath = path.resolve(output);
  check(reportPath !== directory && !reportPath.startsWith(directory + path.sep), '验收报告必须独立于固件整理目录');
  await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
  const report = { schema: 1, config, images: [], verifiedAt: null };
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  const settings = { ...readSettings(await fs.promises.readFile(diy, 'utf8')), sourceVersion: env.LUCI_EDITION };
  const generator = await fs.promises.readFile(options.generator || env.GENE_PATH, 'utf8');
  const filenames = await fs.promises.readdir(directory);
  const manifests = filenames.filter(name => name.endsWith('.manifest'));
  check(manifests.length === 1, '无法唯一读取固件 manifest');
  const packages = (await fs.promises.readFile(path.join(directory, manifests[0]), 'utf8')).trim().split(/\r?\n/).map(line => {
    const match = line.match(/^([a-z0-9][a-z0-9+_.-]*) - \S.*$/);
    check(match, '固件 manifest 格式错误'); return match[1];
  });
  const repo = await fs.promises.realpath(path.resolve(__dirname, '..'));
  const tmp = path.join(repo, 'tmp');
  await fs.promises.mkdir(tmp, { recursive: true });
  const resolvedTmp = await fs.promises.realpath(tmp);
  check(resolvedTmp.startsWith(repo + path.sep), '运行验收临时目录必须位于项目内');
  const work = await fs.promises.mkdtemp(path.join(tmp, 'immortalwrt-runtime-'));
  let currentWork, currentImage;
  try {
    for (const boot of ['legacy', 'uefi']) {
      const suffix = boot === 'uefi' ? '-squashfs-combined-efi.img.gz' : '-squashfs-combined.img.gz';
      const matches = filenames.filter(name => name.endsWith(suffix));
      check(matches.length === 1, '验收镜像缺失或不唯一: ' + boot);
      const file = matches[0], image = path.join(directory, file), digest = await sha256(image);
      const bootWork = path.join(work, boot);
      currentWork = bootWork; currentImage = { boot, file, sha256: digest };
      await fs.promises.mkdir(bootWork);
      const baseImage = path.join(bootWork, 'firmware.raw');
      await pipeline(fs.createReadStream(image), zlib.createGunzip(), fs.createWriteStream(baseImage, { flags: 'wx' }));
      const observed = await bootAndObserve({ baseImage, boot, settings, generator, work: bootWork,
        qemu: options.qemu || 'qemu-system-x86_64', qemuImg: options.qemuImg || 'qemu-img', qemuData: options.qemuData,
        ovmfCode: options.ovmfCode || '/usr/share/OVMF/OVMF_CODE.fd', ovmfVars: options.ovmfVars || '/usr/share/OVMF/OVMF_VARS.fd' });
      validateObservation(observed, settings, packages);
      check(observed.efi === (boot === 'uefi'), '实际引导类型错误');
      check(await sha256(image) === digest, '测试期间原始镜像发生变化');
      report.images.push({ boot, file, sha256: digest, observed });
      console.log(JSON.stringify({ boot, result: '运行验收通过', address: observed.lan['ipv4-address'], kernel: observed.board.kernel }));
    }
    report.verifiedAt = new Date().toISOString();
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (error) {
    const observedPath = currentWork && path.join(currentWork, 'observed.json');
    const serialPath = currentWork && path.join(currentWork, 'serial.log');
    report.failure = { ...currentImage, message: error.message,
      observed: observedPath && fs.existsSync(observedPath) ? JSON.parse(await fs.promises.readFile(observedPath, 'utf8')) : null,
      serial: serialPath && fs.existsSync(serialPath) ? await fs.promises.readFile(serialPath, 'utf8') : '' };
    try { await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
    catch (writeError) { console.error('保存失败验收记录失败: ' + writeError.message); }
    console.error(JSON.stringify({ boot: currentImage?.boot, error: error.message, observed: report.failure.observed?.uci }));
    throw error;
  } finally {
    const resolved = await fs.promises.realpath(work);
    check(resolved.startsWith(resolvedTmp + path.sep), '运行验收临时路径越界');
    await fs.promises.rm(resolved, { recursive: true });
  }
}

module.exports = { verifyFirmware, bootAndObserve, inspectLuci };
if (require.main === module) {
  const { values } = parseArgs({ options: Object.fromEntries(['directory', 'report', 'config', 'diy', 'generator', 'qemu', 'qemu-img', 'qemu-data', 'ovmf-code', 'ovmf-vars'].map(name => [name, { type: 'string' }])) });
  verifyFirmware({ ...values, qemuImg: values['qemu-img'], qemuData: values['qemu-data'], ovmfCode: values['ovmf-code'], ovmfVars: values['ovmf-vars'] })
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
