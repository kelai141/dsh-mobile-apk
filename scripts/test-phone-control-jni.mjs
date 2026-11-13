#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const evidenceRoot = path.resolve(repoRoot, '..', 'evidence', 'jni-host-smoke');
const runId = new Date().toISOString().replace(/[^0-9A-Za-z]/g, '-');
const evidenceRun = path.join(evidenceRoot, `run-${runId}`);
const stateDirA = path.join(evidenceRun, 'state-a');
const stateDirB = path.join(evidenceRun, 'state-b');
const harnessClasses = path.join(evidenceRun, 'harness-classes');
const fixtureSource = path.join(repoRoot, 'scripts', 'fixtures', 'NativeControlJniProbe.java');
const kotlinClasses = path.join(repoRoot, 'app', 'build', 'tmp', 'kotlin-classes', 'debug');
const kotlinClass = path.join(
  kotlinClasses,
  'com',
  'dsharnessmobile',
  'shell',
  'nativecontrol',
  'NativeControlCore.class',
);
const crateDir = path.join(repoRoot, 'native', 'phone-control-core');
const hostDll = path.join(crateDir, 'target', 'debug', 'dsh_phone_control_core.dll');
const rustJniSource = path.join(crateDir, 'src', 'jni_api.rs');
const appUid = 10123;
const receiptData = {
  note: '中文回执',
  supplementary: '😀𠀀',
  nested: { text: '补充平面 𠀀', count: 2 },
};

const summary = {
  schema: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  runId,
  evidenceRun: relativeTo(evidenceRoot, evidenceRun),
  scope: 'host JNI smoke for the Gradle-compiled Kotlin class',
  commands: [],
  checks: [],
  inputs: {},
  outputs: {},
  responses: {},
  limitation: 'host-test build does not verify Android UID ownership; identityVerified is expected false',
};

function relativeTo(base, target) {
  return path.relative(base, target).split(path.sep).join('/');
}

function hashFile(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function findKotlinStdlib() {
  const build = fs.readFileSync(path.join(repoRoot, 'build.gradle.kts'), 'utf8');
  const version = /id\("org\.jetbrains\.kotlin\.android"\)\s+version\s+"([^"]+)"/.exec(build)?.[1];
  assert.ok(version, 'missing Kotlin Android version in build.gradle.kts');
  const gradle = process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
  const cached = path.join(gradle, 'caches', 'modules-2', 'files-2.1', 'org.jetbrains.kotlin', 'kotlin-stdlib', version);
  const jar = `kotlin-stdlib-${version}.jar`;
  const candidates = fs.readdirSync(cached, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(cached, entry.name, jar)).filter((file) => fs.existsSync(file));
  assert.equal(candidates.length, 1, `expected one resolved Gradle stdlib ${jar}`);
  return candidates[0];
}

function describeFile(file, base) {
  const stat = fs.statSync(file);
  return {
    path: relativeTo(base, file),
    bytes: stat.size,
    sha256: hashFile(file),
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      resolve({ command, args, code: null, signal: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code, signal) => {
      resolve({ command, args, code, signal, stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function startProbe(java, args, env) {
  const child = spawn(java, args, {
    cwd: repoRoot,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.setDefaultEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const pending = new Map();
  const records = [];
  const rawLines = [];
  let stdoutBuffer = '';
  let stderr = '';
  let sequence = 0;
  let exited = false;
  let exitResult = null;

  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      rawLines.push(line);
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        failPending(new Error(`Java emitted non-JSON stdout: ${error.message}`));
        continue;
      }
      records.push(record);
      const waiter = pending.get(record.id);
      if (waiter) {
        pending.delete(record.id);
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      }
    }
  });

  const exitPromise = new Promise((resolve) => {
    child.on('error', (error) => {
      exited = true;
      exitResult = { code: null, signal: null, error: error.message };
      failPending(error);
      resolve(exitResult);
    });
    child.on('close', (code, signal) => {
      exited = true;
      exitResult = { code, signal };
      if (stdoutBuffer.trim()) {
        rawLines.push(stdoutBuffer.replace(/\r$/, ''));
        stdoutBuffer = '';
      }
      failPending(new Error(`Java exited before replying (code=${code}, signal=${signal})`));
      resolve(exitResult);
    });
  });

  function failPending(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }

  function call(op, fields = {}) {
    if (exited) {
      return Promise.reject(new Error('Java probe already exited'));
    }
    sequence += 1;
    const id = `p${sequence}`;
    const stateDir = fields.stateDir ?? '';
    const payload = fields.payload === undefined ? '' : JSON.stringify(fields.payload);
    const line = [
      id,
      op,
      Buffer.from(stateDir, 'utf8').toString('base64'),
      fields.appUid === undefined ? '' : String(fields.appUid),
      Buffer.from(payload, 'utf8').toString('base64'),
      fields.binary?.toString('base64') ?? '',
    ].join('\t');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${op} (${id})`));
      }, 120000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${line}\n`, 'utf8', (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async function close() {
    if (!exited) {
      child.stdin.end();
    }
    return exitPromise;
  }

  return {
    call,
    close,
    get rawLines() { return [...rawLines]; },
    get stderr() { return stderr; },
    get records() { return [...records]; },
  };
}

function parseResponse(record, label) {
  assert.ok(record, `${label}: no probe record`);
  assert.equal(record.invoked, true, `${label}: native entry was not invoked: ${JSON.stringify(record)}`);
  assert.equal(typeof record.response, 'string', `${label}: response is not a string`);
  let response;
  try {
    response = JSON.parse(record.response);
  } catch (error) {
    throw new Error(`${label}: native response is not JSON: ${error.message}; raw=${record.response}`);
  }
  assert.equal(typeof response, 'object', `${label}: JSON response is not an object`);
  assert.ok(response !== null, `${label}: JSON response is null`);
  return response;
}

function check(name, fn) {
  try {
    fn();
    summary.checks.push({ name, ok: true });
  } catch (error) {
    summary.checks.push({ name, ok: false, error: error.message });
    throw new Error(`${name}: ${error.message}`);
  }
}

function isOpaqueId(value) {
  return typeof value === 'string' && /^[0-9]+$/.test(value) && value.length > 0;
}

async function main() {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(evidenceRun, { recursive: true });
  fs.mkdirSync(stateDirA, { recursive: true });
  fs.mkdirSync(stateDirB, { recursive: true });
  fs.mkdirSync(harnessClasses, { recursive: true });
  const kotlinStdlib = findKotlinStdlib();

  summary.inputs = {
    script: describeFile(scriptPath, repoRoot),
    fixtureSource: describeFile(fixtureSource, repoRoot),
    kotlinSource: describeFile(
      path.join(repoRoot, 'app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell', 'nativecontrol', 'NativeControlCore.kt'),
      repoRoot,
    ),
    rustJniSource: describeFile(rustJniSource, repoRoot),
    kotlinClass: describeFile(kotlinClass, repoRoot),
    kotlinStdlib: describeFile(kotlinStdlib, path.dirname(kotlinStdlib)),
  };

  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome
    ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac')
    : 'javac';
  const java = javaHome
    ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : 'java';

  const javacVersion = await run(javac, ['-version']);
  summary.commands.push({ step: 'javac-version', ...javacVersion });
  assert.equal(javacVersion.code, 0, `javac -version failed: ${javacVersion.stderr || javacVersion.error}`);
  assert.match(
    `${javacVersion.stdout}${javacVersion.stderr}`,
    /^javac 17\./m,
    'JDK 17 is required for the harness',
  );
  check('JDK is 17', () => {
    assert.match(`${javacVersion.stdout}${javacVersion.stderr}`, /^javac 17\./m);
  });

  const cargo = await run(
    'cargo',
    ['+stable-x86_64-pc-windows-gnu', 'build', '--lib', '--locked', '--offline'],
    { cwd: crateDir },
  );
  summary.commands.push({ step: 'cargo-host-build', ...cargo });
  assert.equal(
    cargo.code,
    0,
    `host cargo build failed (code=${cargo.code}): ${cargo.stderr || cargo.stdout || cargo.error}`,
  );
  check('host cargo build succeeded', () => {
    assert.equal(cargo.code, 0);
    assert.ok(fs.existsSync(hostDll), `missing host DLL ${hostDll}`);
  });

  summary.outputs.hostDll = describeFile(hostDll, evidenceRun);

  const compile = await run(
    javac,
    ['-encoding', 'UTF-8', '-source', '17', '-target', '17', '-d', harnessClasses, fixtureSource],
  );
  summary.commands.push({ step: 'javac-harness', ...compile });
  assert.equal(
    compile.code,
    0,
    `javac harness failed (code=${compile.code}): ${compile.stderr || compile.stdout || compile.error}`,
  );
  check('harness compiled', () => {
    assert.equal(compile.code, 0);
  });

  const harnessClass = path.join(harnessClasses, 'NativeControlJniProbe.class');
  summary.outputs.harnessClass = describeFile(harnessClass, evidenceRun);

  const rustlibBin = path.join(
    os.homedir(),
    '.rustup',
    'toolchains',
    'stable-x86_64-pc-windows-gnu',
    'lib',
    'rustlib',
    'x86_64-pc-windows-gnu',
    'bin',
  );
  const pathParts = [
    path.dirname(hostDll),
    ...(fs.existsSync(rustlibBin) ? [rustlibBin] : []),
    process.env.PATH ?? '',
  ];
  const javaEnv = { ...process.env, PATH: pathParts.join(path.delimiter) };
  const javaArgs = [
    '-Xcheck:jni',
    '-Dfile.encoding=UTF-8',
    `-Djava.library.path=${path.dirname(hostDll)}`,
    '-cp',
    [harnessClasses, kotlinClasses, kotlinStdlib].join(path.delimiter),
    'NativeControlJniProbe',
  ];
  summary.commands.push({
    step: 'java-probe',
    command: java,
    args: javaArgs,
    cwd: repoRoot,
    shell: false,
  });

  const probe = startProbe(java, javaArgs, javaEnv);
  try {
    const probeRecord = await probe.call('probe');
    assert.equal(probeRecord.invoked, false);
    assert.ok(probeRecord.probe, `class probe failed: ${JSON.stringify(probeRecord)}`);
    check('actual Kotlin class exposes the six static native entries', () => {
      assert.equal(probeRecord.probe.className, 'com.dsharnessmobile.shell.nativecontrol.NativeControlCore');
      assert.equal(probeRecord.probe.methods.length, 6);
      const byName = new Map(probeRecord.probe.methods.map((method) => [method.name, method]));
      for (const name of ['initialize', 'exchange', 'exchangeNonblocking']) {
        const method = byName.get(name);
        assert.ok(method, `missing ${name}`);
        assert.equal(method.native, true, `${name} is not native`);
        assert.equal(method.static, true, `${name} is not static`);
        assert.equal(method.returnType, 'java.lang.String', `${name} return type`);
      }
      assert.deepEqual(byName.get('initialize').params, ['java.lang.String', 'int']);
      assert.deepEqual(byName.get('exchange').params, ['java.lang.String']);
      assert.deepEqual(byName.get('exchangeNonblocking').params, ['java.lang.String']);
      assert.deepEqual(byName.get('encodeFrame').params, ['java.lang.String', '[B']);
      assert.equal(byName.get('encodeFrame').returnType, 'java.lang.String');
      assert.deepEqual(byName.get('publishTree').params, ['java.lang.String', 'java.lang.String']);
      assert.equal(byName.get('publishTree').returnType, 'java.lang.String');
      assert.deepEqual(byName.get('readImage').params, ['java.lang.String']);
      assert.equal(byName.get('readImage').returnType, 'com.dsharnessmobile.shell.nativecontrol.NativeImageResult');
    });
    check('loaded class comes from the Gradle debug class directory', () => {
      const codeSource = probeRecord.probe.codeSource;
      assert.ok(codeSource.startsWith('file:'), `unexpected code source ${codeSource}`);
      const resolved = path.resolve(fileURLToPath(codeSource));
      assert.equal(resolved.toLowerCase(), kotlinClasses.toLowerCase());
      assert.match(probeRecord.probe.resource, /NativeControlCore\.class$/);
    });

    const firstInit = parseResponse(
      await probe.call('initialize', { stateDir: stateDirA, appUid }),
      'initialize first',
    );
    summary.responses.initializeFirst = firstInit;
    check('host initialize reports host-test and identityVerified false', () => {
      assert.equal(firstInit.ok, true);
      assert.equal(firstInit.code, 'initialized');
      assert.equal(firstInit.platform, 'host-test');
      assert.equal(firstInit.identityVerified, false);
      assert.equal(firstInit.appUid, appUid);
      assert.equal(firstInit.idempotent, false);
      assert.ok(isOpaqueId(firstInit.epoch), `epoch is not an opaque string: ${JSON.stringify(firstInit.epoch)}`);
    });

    const repeatInit = parseResponse(
      await probe.call('initialize', { stateDir: stateDirA, appUid }),
      'initialize repeat',
    );
    summary.responses.initializeRepeat = repeatInit;
    check('same directory and UID repeat is idempotent with unchanged epoch', () => {
      assert.equal(repeatInit.ok, true);
      assert.equal(repeatInit.code, 'already-initialized');
      assert.equal(repeatInit.idempotent, true);
      assert.equal(repeatInit.epoch, firstInit.epoch);
      assert.equal(repeatInit.platform, 'host-test');
      assert.equal(repeatInit.identityVerified, false);
    });

    const differentDir = parseResponse(
      await probe.call('initialize', { stateDir: stateDirB, appUid }),
      'initialize different directory',
    );
    summary.responses.initializeDifferentDir = differentDir;
    check('different directory is rejected', () => {
      assert.equal(differentDir.ok, false);
      assert.equal(differentDir.code, 'already-initialized');
      assert.equal(differentDir.executed, 'unknown');
      assert.equal(differentDir.epoch, undefined);
    });

    const facts = {
      protocolVersion: 1,
      kind: 'publishFacts',
      facts: {
        scope: 'all',
        observedAtMs: 1,
        screens: {
          real: { displayId: 0, width: 8, height: 4, rotation: 0 },
          'virtual-1': { displayId: 41, width: 1080, height: 1920, rotation: 0 },
        },
        a11y: {
          enabled: 'yes',
          online: 'yes',
          supportedOps: { state: 'known', ops: ['click', 'snapshot', 'readRegion'] },
          displaySupport: { state: 'known', values: { '0': true, '41': true } },
        },
        shizuku: {},
        root: { authorization: 'unknown', consentValid: 'unknown' },
      },
    };
    const published = parseResponse(
      await probe.call('exchange', { payload: facts }),
      'publishFacts',
    );
    summary.responses.publishFacts = published;
    check('publishFacts accepts real protocol JSON', () => {
      assert.equal(published.ok, true);
      assert.equal(published.code, 'facts-published');
      assert.equal(published.executed, 'no');
    });

    const capabilities = parseResponse(
      await probe.call('exchangeNonblocking', { payload: { protocolVersion: 1, kind: 'capabilities' } }),
      'capabilities',
    );
    summary.responses.capabilities = capabilities;
    check('capabilities expose epoch, revision and generation as opaque strings', () => {
      assert.equal(capabilities.ok, true);
      assert.equal(capabilities.protocolVersion, 1);
      assert.equal(capabilities.epoch, firstInit.epoch);
      assert.ok(isOpaqueId(capabilities.revision), `revision is not an opaque string: ${JSON.stringify(capabilities.revision)}`);
      const screen = capabilities.screens.find((entry) => entry.screenId === 'virtual-1');
      assert.ok(screen, 'virtual-1 missing from capabilities');
      assert.ok(isOpaqueId(screen.generation), `generation is not an opaque string: ${JSON.stringify(screen.generation)}`);
    });

    const preparePayload = {
      protocolVersion: 1,
      kind: 'prepare',
      callId: 'jni-click-1',
      operation: 'click',
      screenId: 'virtual-1',
      epoch: firstInit.epoch,
      args: { x: 120, y: 240 },
    };
    const prepared = parseResponse(
      await probe.call('exchange', { payload: preparePayload }),
      'prepare click',
    );
    summary.responses.prepare = prepared;
    check('prepare click returns a plan with opaque generation', () => {
      assert.equal(prepared.ok, true);
      assert.equal(prepared.code, 'prepared');
      assert.equal(prepared.screenId, 'virtual-1');
      assert.equal(prepared.plan.operation, 'click');
      assert.equal(prepared.plan.epoch, firstInit.epoch);
      assert.ok(isOpaqueId(prepared.plan.generation), `plan generation is not an opaque string: ${JSON.stringify(prepared.plan.generation)}`);
    });

    const nonblockingCommit = parseResponse(
      await probe.call('exchangeNonblocking', {
        payload: { protocolVersion: 1, kind: 'commit', callId: 'jni-click-1' },
      }),
      'nonblocking commit rejection',
    );
    summary.responses.nonblockingCommit = nonblockingCommit;
    check('nonblocking entry rejects commit', () => {
      assert.equal(nonblockingCommit.ok, false);
      assert.equal(nonblockingCommit.code, 'blocking-operation-rejected');
      assert.equal(nonblockingCommit.executed, 'unknown');
    });

    const committed = parseResponse(
      await probe.call('exchange', {
        payload: { protocolVersion: 1, kind: 'commit', callId: 'jni-click-1' },
      }),
      'commit',
    );
    summary.responses.commit = committed;
    check('commit permits dispatch', () => {
      assert.equal(committed.ok, true);
      assert.equal(committed.code, 'dispatched');
      assert.equal(committed.dispatch, 'permitted');
      assert.equal(committed.callId, 'jni-click-1');
    });

    const validated = parseResponse(
      await probe.call('exchangeNonblocking', {
        payload: { protocolVersion: 1, kind: 'validateDispatch', callId: 'jni-click-1' },
      }),
      'nonblocking validateDispatch',
    );
    summary.responses.validateDispatch = validated;
    check('nonblocking validateDispatch reports valid and permitted', () => {
      assert.equal(validated.ok, false);
      assert.equal(validated.code, 'dispatch-validated');
      assert.equal(validated.valid, true);
      assert.equal(validated.dispatch, 'permitted');
      assert.equal(validated.phase, 'dispatching');
      assert.ok(isOpaqueId(validated.plan.generation));
    });

    const settlePayload = {
      protocolVersion: 1,
      kind: 'settle',
      callId: 'jni-click-1',
      receipt: {
        ok: true,
        code: 'clicked',
        executed: 'yes',
        screenId: 'virtual-1',
        data: receiptData,
      },
    };
    const settled = parseResponse(
      await probe.call('exchange', { payload: settlePayload }),
      'settle',
    );
    summary.responses.settle = settled;
    check('settle returns Chinese and supplementary-plane data unchanged', () => {
      assert.equal(settled.ok, true);
      assert.equal(settled.code, 'clicked');
      assert.equal(settled.executed, 'yes');
      assert.equal(settled.callId, 'jni-click-1');
      assert.deepEqual(settled.data, receiptData);
    });

    const beforeReplay = parseResponse(
      await probe.call('exchangeNonblocking', { payload: { protocolVersion: 1, kind: 'capabilities' } }),
      'capabilities before replay',
    );
    const replay = parseResponse(
      await probe.call('exchange', { payload: preparePayload }),
      'same-call replay',
    );
    const afterReplay = parseResponse(
      await probe.call('exchangeNonblocking', { payload: { protocolVersion: 1, kind: 'capabilities' } }),
      'capabilities after replay',
    );
    summary.responses.replay = replay;
    check('same-call replay returns the receipt without a new dispatch', () => {
      assert.equal(replay.replayed, true);
      assert.equal(replay.ok, true);
      assert.equal(replay.executed, 'yes');
      assert.equal(replay.code, 'clicked');
      assert.equal(replay.dispatch, undefined);
      assert.deepEqual(replay.data, receiptData);
      assert.equal(afterReplay.lifecycleRecords, beforeReplay.lifecycleRecords);
    });

    const unknownPrepare = {
      protocolVersion: 1,
      kind: 'prepare',
      callId: 'jni-unknown-1',
      operation: 'click',
      screenId: 'virtual-1',
      epoch: firstInit.epoch,
      args: { x: 300, y: 400 },
    };
    const unknownPrepared = parseResponse(
      await probe.call('exchange', { payload: unknownPrepare }),
      'unknown prepare',
    );
    assert.equal(unknownPrepared.ok, true);
    const unknownCommitted = parseResponse(
      await probe.call('exchange', {
        payload: { protocolVersion: 1, kind: 'commit', callId: 'jni-unknown-1' },
      }),
      'unknown commit',
    );
    assert.equal(unknownCommitted.ok, true);
    const unknownSettled = parseResponse(
      await probe.call('exchange', {
        payload: {
          protocolVersion: 1,
          kind: 'settle',
          callId: 'jni-unknown-1',
          receipt: { ok: false, code: 'timeout', executed: 'unknown', screenId: 'virtual-1' },
        },
      }),
      'unknown settle',
    );
    summary.responses.unknownSettle = unknownSettled;
    check('unknown settle is recorded as unknown', () => {
      assert.equal(unknownSettled.ok, false);
      assert.equal(unknownSettled.code, 'timeout');
      assert.equal(unknownSettled.executed, 'unknown');
    });

    const unknownNewId = parseResponse(
      await probe.call('exchange', {
        payload: { ...unknownPrepare, callId: 'jni-unknown-2' },
      }),
      'unknown new id',
    );
    summary.responses.unknownNewId = unknownNewId;
    check('same semantic request with a new ID is rejected after unknown', () => {
      assert.equal(unknownNewId.ok, false);
      assert.equal(unknownNewId.code, 'operation-unknown');
      assert.equal(unknownNewId.plan, undefined);
    });

    const control = async (payload) => parseResponse(await probe.call('exchange', {
      payload: { protocolVersion: 1, ...payload },
    }), payload.kind);
    const callId = 'jni-region-1';
    const region = { x1: 2, y1: 1, x2: 7, y2: 4 };
    const prepareImage = await control({ kind: 'prepare', callId, operation: 'readRegion', screenId: 'real',
      epoch: firstInit.epoch, args: region });
    assert.equal(prepareImage.code, 'prepared');
    const commitImage = await control({ kind: 'commit', callId });
    assert.equal(commitImage.dispatch, 'permitted');
    const plan = commitImage.plan;
    const pixels = Buffer.from(Array.from({ length: 8 * 4 }, (_, i) => [i * 4, 180, 20, 255]).flat());
    const encoded = parseResponse(await probe.call('encodeFrame', { binary: pixels, payload: {
      callId, epoch: plan.epoch, generation: plan.generation, screenId: plan.screenId, displayId: plan.displayId,
      width: 8, height: 4, logicalWidth: 8, logicalHeight: 4, rowStride: 32,
      transform: 'identity', premultipliedAlpha: false,
    } }), 'encodeFrame');
    check('encodeFrame returns a logical rectangle receipt, not JPEG bytes', () => {
      assert.equal(encoded.ok, true, JSON.stringify(encoded));
      assert.equal(encoded.executed, 'yes');
      assert.deepEqual(encoded.data.image.region, region);
      assert.equal(encoded.data.image.width, 8);
      assert.equal(encoded.data.image.height, 4);
      assert.equal(encoded.data.image.data, undefined);
    });
    const readImage = async () => parseResponse(await probe.call('readImage', { stateDir: callId }), 'readImage');
    const beforeSettle = await readImage();
    check('readImage returns no JPEG before settlement', () => {
      assert.equal(beforeSettle.jpeg, null);
      assert.equal(JSON.parse(beforeSettle.metadata).code, 'image-not-settled');
    });
    assert.equal((await control({ kind: 'settle', callId, receipt: encoded })).ok, true);
    const delivered = await readImage();
    check('readImage returns the exact JPEG as a Kotlin JNI byte array', () => {
      const jpeg = Buffer.from(delivered.jpeg, 'base64');
      assert.deepEqual(JSON.parse(delivered.metadata), encoded.data.image);
      assert.equal(jpeg.length, encoded.data.image.bytes);
      assert.equal(createHash('sha256').update(jpeg).digest('hex'), encoded.data.image.sha256);
      assert.equal(jpeg.readUInt16BE(0), 0xffd8);
      assert.equal(jpeg.readUInt16BE(jpeg.length - 2), 0xffd9);
    });
    summary.responses.visualReceipt = encoded;
  } finally {
    const exit = await probe.close();
    summary.commands.push({
      step: 'java-probe-exit',
      code: exit.code,
      signal: exit.signal,
      stderr: probe.stderr,
    });
    fs.writeFileSync(path.join(evidenceRun, 'probe.ndjson'), `${probe.rawLines.join('\n')}\n`, 'utf8');
    summary.rawRecords = probe.records;
    if (exit.code !== 0) {
      throw new Error(`Java probe exited with code ${exit.code}: ${probe.stderr}`);
    }
  }
}

let failure = null;
try {
  await main();
  summary.status = 'passed';
} catch (error) {
  failure = error;
  summary.status = 'failed';
  summary.error = error && error.stack ? error.stack : String(error);
}

summary.finishedAt = new Date().toISOString();
summary.checks = summary.checks ?? [];
summary.artifact = 'summary.json';
if (!fs.existsSync(evidenceRun)) {
  fs.mkdirSync(evidenceRun, { recursive: true });
}
writeJson(path.join(evidenceRun, 'summary.json'), summary);

if (failure) {
  console.error(`FAIL ${failure.message}`);
  console.error(`evidence: ${evidenceRun}`);
  process.exitCode = 1;
} else {
  console.log(`PASS ${summary.checks.length} checks`);
  console.log(`evidence: ${evidenceRun}`);
}
