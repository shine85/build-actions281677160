const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_ERROR_EVENTS = 200;
const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError']);
const ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ESRCH', 'ETIMEDOUT', 'ENOSPC', 'UNSUPPORTED_PLATFORM', 'NO_WORKER_LOG']);
const COMPONENTS = new Set([
  'Runner', 'Worker', 'JobRunner', 'JobDispatcher', 'JobServerQueue',
  'RunnerServer', 'RunServer', 'ResultsServer', 'BrokerServer', 'MessageListener',
  'ExecutionContext', 'HostContext', 'VssHttpMessageHandler', 'VssHttpRetryMessageHandler',
]);
const ENVIRONMENT_FIELDS = [
  'ImageOS', 'ImageVersion', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT',
  'RUNNER_DEBUG', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA',
];

function countMatches(text, pattern) {
  const counts = {};
  for (const match of text.matchAll(pattern)) {
    counts[match[1]] = (counts[match[1]] || 0) + 1;
  }
  return counts;
}

function summarizeLog(filePath, role, limitBytes = MAX_LOG_BYTES) {
  const descriptor = fs.openSync(filePath, 'r');
  let fileBytes;
  let sampledBytes;
  let text;
  try {
    fileBytes = fs.fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(fileBytes, limitBytes));
    sampledBytes = fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, fileBytes - limitBytes));
    text = buffer.subarray(0, sampledBytes).toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  const severityCounts = {WARN: 0, ERR: 0};
  const events = [];
  const eventPattern = /^\[(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z)[ \t]+(WARN|ERR)[ \t]+([^\]\r\n]+)\]/gm;
  for (const match of text.matchAll(eventPattern)) {
    severityCounts[match[2]]++;
    events.push({
      timestamp: match[1],
      severity: match[2],
      component: COMPONENTS.has(match[3]) ? match[3] : 'Other',
    });
  }
  return {
    role,
    file_bytes: fileBytes,
    sampled_bytes: sampledBytes,
    truncated: fileBytes > sampledBytes,
    severity_counts: severityCounts,
    exception_counts: countMatches(text, /\b(HttpRequestException|TaskCanceledException|OperationCanceledException|TimeoutException|SocketException|AuthenticationException|IOException|UnauthorizedAccessException|OutOfMemoryException)\b/g),
    http_status_counts: countMatches(text, /\b(?:StatusCode|status code|HTTP(?:\/\d(?:\.\d)?)?)\s*[:=(]?\s*([1-5]\d\d)\b/gi),
    events: events.slice(-MAX_ERROR_EVENTS),
    omitted_events: Math.max(0, events.length - MAX_ERROR_EVENTS),
  };
}

function parseMemory(text) {
  const values = Object.fromEntries(text.split(/\r?\n/).map(line => line.split(':', 2)));
  return Object.fromEntries(['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'].map(name => {
    const value = Number.parseInt(values[name], 10);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid memory field: ${name}`);
    return [name, value];
  }));
}

function runnerMetadata(environment) {
  return Object.fromEntries(ENVIRONMENT_FIELDS.filter(name => environment[name] !== undefined).map(name => [name, environment[name]]));
}

function collectSnapshot(stage) {
  if (process.platform !== 'linux') throw Object.assign(new Error('Runner resource collection requires Linux'), {code: 'UNSUPPORTED_PLATFORM'});
  const processOutput = execFileSync('ps', ['-C', 'Runner.Listener,Runner.Worker', '-o', 'pid=,pcpu=,pmem=,rss=,stat=,comm='], {
    encoding: 'utf8', timeout: 5000,
  });
  const processes = processOutput.trim().split(/\r?\n/).map(line => {
    const [processId, cpu, memory, resident, state, name] = line.trim().split(/\s+/);
    if (!['Runner.Listener', 'Runner.Worker'].includes(name)) throw new Error('Unexpected runner process');
    return {pid: Number(processId), cpu_percent: Number(cpu), memory_percent: Number(memory), rss_kib: Number(resident), state, name};
  });
  const diagnosticRoots = new Set(processes.map(runnerProcess => {
    const executable = fs.readlinkSync(`/proc/${runnerProcess.pid}/exe`);
    return path.resolve(path.dirname(executable), '..', '_diag');
  }));
  const diagnostics = [];
  for (const directory of diagnosticRoots) {
    const names = fs.readdirSync(directory).sort();
    for (const [prefix, role] of [['Runner_', 'listener'], ['Worker_', 'worker']]) {
      const fileName = names.filter(name => name.startsWith(prefix) && name.endsWith('.log')).at(-1);
      if (fileName) diagnostics.push(summarizeLog(path.join(directory, fileName), role));
    }
  }
  if (!diagnostics.some(summary => summary.role === 'worker')) throw Object.assign(new Error('No readable Worker diagnostic log found'), {code: 'NO_WORKER_LOG'});
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const disk = fs.statfsSync(workspace);
  return {
    stage,
    captured_at: new Date().toISOString(),
    runner: runnerMetadata(process.env),
    resources: {
      load_average: os.loadavg(),
      memory_kib: parseMemory(fs.readFileSync('/proc/meminfo', 'utf8')),
      workspace_disk_bytes: {total: disk.blocks * disk.bsize, available: disk.bavail * disk.bsize},
    },
    processes,
    diagnostics,
  };
}

function writeSnapshot(stage, outputDirectory, collector = collectSnapshot) {
  let snapshot;
  try {
    snapshot = {...collector(stage), status: 'collected'};
  } catch (error) {
    snapshot = {
      stage,
      captured_at: new Date().toISOString(),
      status: 'collection_failed',
      failure: {
        type: ERROR_TYPES.has(error?.name) ? error.name : 'UnknownError',
        code: ERROR_CODES.has(error?.code) ? error.code : 'UNKNOWN',
      },
    };
  }
  fs.mkdirSync(outputDirectory, {recursive: true});
  fs.writeFileSync(path.join(outputDirectory, `${stage}.json`), JSON.stringify(snapshot, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'});
  return snapshot;
}

function main() {
  const [stage, outputDirectory = path.join('tmp', 'runner-diagnostics')] = process.argv.slice(2);
  if (process.argv.length > 4 || !/^[a-z][a-z0-9-]{0,39}$/.test(stage || '')) {
    throw new Error('Usage: node tools/runner-diagnostics.cjs <stage> [output-directory]');
  }
  const snapshot = writeSnapshot(stage, outputDirectory);
  console.log(JSON.stringify({stage, captured_at: snapshot.captured_at, status: snapshot.status, failure: snapshot.failure}));
  if (snapshot.status !== 'collected') process.exitCode = 1;
}

module.exports = {summarizeLog, parseMemory, runnerMetadata, writeSnapshot};
if (require.main === module) main();
