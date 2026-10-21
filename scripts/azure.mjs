import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rename, open, unlink } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const apiVersion = '2025-06-01';
const arm = 'https://management.azure.com';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enumIs = (value, expected) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
export const terminal = state => ['succeeded', 'failed', 'cancelled', 'cleanup-failed'].includes(state);

export async function loadConfig() {
  let data;
  try { data = JSON.parse(await readFile(path.join(root, 'azure.local.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Invalid azure.local.json. Run npm run azure:configure.'); }
  if (data.enabled !== true) return null;
  if (!uuid.test(data.subscriptionId) || data.location !== 'centralindia' || data.vmSize !== 'Standard_NC4as_T4_v3')
    throw new Error('Azure configuration must select a subscription UUID, Central India, and Standard_NC4as_T4_v3.');
  return { subscriptionId: data.subscriptionId, location: data.location, vmSize: data.vmSize, maxMinutes: 15 };
}

export class AzureTransport {
  constructor(subscriptionId) { this.subscription = subscriptionId; this.tokens = new Map(); }
  async token(resource) {
    const cached = this.tokens.get(resource);
    if (cached && cached.expires > Date.now() + 120000) return cached.value;
    let command = 'az', args = [];
    if (process.platform === 'win32') {
      command = [process.env.PIXELPTX_AZURE_PYTHON,
        'C:/Program Files/Microsoft SDKs/Azure/CLI2/python.exe',
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Azure CLI/python.exe')].filter(Boolean).find(existsSync);
      if (!command) throw new Error('Azure CLI Python runtime not found. Set PIXELPTX_AZURE_PYTHON to its python.exe.');
      args = ['-m', 'azure.cli'];
    }
    let response;
    try { response = await exec(command, [...args, 'account', 'get-access-token', '--subscription', this.subscription,
      '--resource', resource, '--output', 'json', '--only-show-errors'], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 }); }
    catch { throw new Error('Azure sign-in is unavailable. Run az login in a terminal, then retry.'); }
    const data = JSON.parse(response.stdout);
    this.tokens.set(resource, { value: data.accessToken, expires: data.expires_on ? Number(data.expires_on) * 1000 : Date.now() + 300000 });
    return data.accessToken;
  }
  async request(method, url, body) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !(parsed.hostname === 'management.azure.com' || /^pixelptx[a-f0-9]+\.centralindia\.batch\.azure\.com$/.test(parsed.hostname)))
      throw new Error('Unexpected Azure service URL.');
    const resource = parsed.hostname === 'management.azure.com' ? 'https://management.core.windows.net/' : 'https://batch.core.windows.net/';
    const token = await this.token(resource);
    const contentType = parsed.hostname === 'management.azure.com' ? 'application/json' : 'application/json;odata=minimalmetadata';
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType,
          'client-request-id': randomUUID(), 'return-client-request-id': 'true' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        break;
      } catch (error) {
        if (!['GET', 'PUT', 'DELETE'].includes(method) || attempt === 2) throw new Error(`Azure ${method} ${parsed.pathname}: ${error.cause?.code || error.message}`);
        await delay(1000 * (attempt + 1));
      }
    }
    // Azure output files are bounded by the compiler input limit. Never read an unbounded response.
    const parts = []; let size = 0;
    for await (const part of response.body ?? []) { size += part.length; if (size > 12 * 1024 * 1024) throw new Error('Azure response exceeded 12 MB.'); parts.push(part); }
    const text = Buffer.concat(parts).toString('utf8');
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message?.value || data?.message || `HTTP ${response.status}`;
      const specifics = data?.error?.details || data?.values || [];
      const context = JSON.stringify(specifics).replace(/[A-Za-z0-9+/=]{120,}/g, '[payload omitted]').slice(0, 3000);
      const error = new Error(`Azure: ${String(detail).slice(0, 2000)}${specifics.length ? ` ${context}` : ''}`); error.status = response.status; throw error;
    }
    return data;
  }
}

export function validateGpuInput(data) {
  if (data.consent !== true) throw new Error('Confirm the Azure compute charge and image upload before starting.');
  if (!uuid.test(data.requestId)) throw new Error('A unique request ID is required.');
  if (typeof data.source !== 'string' || Buffer.byteLength(data.source) > 8192 || /[^\x00-\x7f]/.test(data.source)) throw new Error('GPU source must be ASCII and at most 8192 bytes.');
  if (!Number.isInteger(data.width) || !Number.isInteger(data.height) || data.width < 1 || data.height < 1 || data.width > 352 || data.height > 256)
    throw new Error('GPU image must be at most 352 × 256 pixels.');
  if (typeof data.rgb !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.rgb) || data.rgb.length > 360448) throw new Error('Invalid RGB image payload.');
  const bytes = Buffer.from(data.rgb, 'base64');
  if (bytes.length !== data.width * data.height * 3 || bytes.toString('base64') !== data.rgb) throw new Error('RGB payload does not match image dimensions.');
  return bytes;
}

export async function makePool(data, compilation, expiresAt, filesRoot = root) {
  const files = {};
  for (const name of ['include/pixelptx/compiler.hpp', 'src/compiler.cpp', 'src/gpu_main.cpp']) files[name] = (await readFile(path.join(filesRoot, name))).toString('base64');
  for (const [name, text] of Object.entries({ 'source.pxp': data.source, 'optimized.ptx': compilation.ptx, 'original.ptx': compilation.beforePtx })) files[name] = Buffer.from(text).toString('base64');
  const encoded = gzipSync(JSON.stringify(files)).toString('base64');
  const environmentSettings = [];
  for (let i = 0; i < encoded.length; i += 16000) environmentSettings.push({ name: `PIXELPTX_BUNDLE_${String(i / 16000).padStart(4, '0')}`, value: encoded.slice(i, i + 16000) });
  const bootstrap = (await readFile(path.join(filesRoot, 'scripts/gpu-bootstrap.py'))).toString('base64');
  const commandLine = `/usr/bin/python3 -c "import base64;exec(base64.b64decode('${bootstrap}'))"`;
  const pool = { properties: {
    vmSize: 'Standard_NC4as_T4_v3',
    taskSlotsPerNode: 4,
    deploymentConfiguration: { virtualMachineConfiguration: {
      imageReference: { publisher: 'microsoft-dsvm', offer: 'ubuntu-hpc', sku: '2404', version: 'latest' },
      nodeAgentSkuId: 'batch.node.ubuntu 24.04',
      osDisk: { managedDisk: { storageAccountType: 'Standard_LRS' } }
    } },
    // Azure evaluates this independently of the laptop. Scale-down is asynchronous, not a spending cap.
    scaleSettings: { autoScale: { evaluationInterval: 'PT5M', formula:
      `$TargetDedicatedNodes=0; $TargetLowPriorityNodes=(time() < time("${new Date(expiresAt).toUTCString()}")) ? 1 : 0; $NodeDeallocationOption=terminate;` } },
    startTask: { commandLine, environmentSettings, waitForSuccess: true, maxTaskRetryCount: 0,
      userIdentity: { autoUser: { scope: 'Pool', elevationLevel: 'NonAdmin' } } },
    metadata: [{ name: 'purpose', value: 'pixelptx-on-demand' }]
  } };
  // The start-task budget is much smaller than the outer REST request budget.
  if (Buffer.byteLength(JSON.stringify(pool.properties.startTask)) > 28000 || commandLine.length > 12000) throw new Error('Compiler bundle exceeds the Azure start-task budget.');
  return pool;
}

export function makeTasks(rgb) {
  const tasks = [], partIds = [];
  // Send bounded chunks through authenticated Batch task definitions, without a storage account or public URL.
  for (let i = 0; i < rgb.length; i += 6000) {
    const id = `part-${String(i / 6000).padStart(4, '0')}`; partIds.push(id);
    const code = `import os,base64,pathlib;p=pathlib.Path(os.environ['AZ_BATCH_NODE_SHARED_DIR'])/'pixelptx';(p/'${id}').write_bytes(base64.b64decode('${rgb.slice(i, i + 6000)}'))`;
    tasks.push({ id, commandLine: `/usr/bin/python3 -c "${code}"`,
      userIdentity: { autoUser: { scope: 'pool', elevationLevel: 'nonadmin' } }, constraints: { maxTaskRetryCount: 0, maxWallClockTime: 'PT1M' } });
  }
  const code = "import os,pathlib,subprocess;p=pathlib.Path(os.environ['AZ_BATCH_NODE_SHARED_DIR'])/'pixelptx';(p/'input.u8').write_bytes(b''.join(f.read_bytes() for f in sorted(p.glob('part-*'))));f=open('result.json','w');r=subprocess.run([str(p/'pixelptx_gpu'),str(p)],stdout=f,timeout=90);f.close();raise SystemExit(r.returncode)";
  tasks.push({ id: 'execute', commandLine: `/usr/bin/python3 -c "${code}"`, dependsOn: { taskIds: partIds },
    userIdentity: { autoUser: { scope: 'pool', elevationLevel: 'nonadmin' } }, constraints: { maxTaskRetryCount: 0, maxWallClockTime: 'PT3M' } });
  return { value: tasks };
}

export class GpuRuns {
  constructor({ config = null, transport = null, folder = path.join(root, '.artifacts/azure-runs'), sleep = delay, pollMs = 10000 } = {}) {
    this.config = config; this.client = transport || (config && new AzureTransport(config.subscriptionId));
    this.folder = folder; this.sleep = sleep; this.pollMs = pollMs; this.runs = new Map(); this.saves = new Map(); this.active = null;
    this.ready = this.recover();
  }
  groupUrl(run) { return `${arm}/subscriptions/${run.subscriptionId}/resourceGroups/${run.group}`; }
  accountUrl(run) { return `${this.groupUrl(run)}/providers/Microsoft.Batch/batchAccounts/${run.account}`; }
  batchUrl(run) { return `https://${run.account}.centralindia.batch.azure.com`; }
  snapshot(run) {
    const { task, cancelling, result, ...publicRun } = run;
    return { ...publicRun, result: result || null, active: !terminal(run.state), ok: true };
  }
  async save(run) {
    const { task, cancelling, result, ...record } = run;
    // Retain diagnostics, never image bytes or channel values in local run history.
    if (result) { const { values, ...diagnostics } = result; record.diagnostics = diagnostics; }
    const filename = path.join(this.folder, `${run.id}.json`);
    const contents = JSON.stringify(record, null, 2);
    const pending = (this.saves.get(run.id) || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.folder, { recursive: true });
      await writeFile(filename + '.tmp', contents); await rename(filename + '.tmp', filename);
    });
    this.saves.set(run.id, pending);
    try { await pending; } finally { if (this.saves.get(run.id) === pending) this.saves.delete(run.id); }
  }
  async stage(run, state, message) {
    run.state = state; run.message = message; run.updatedAt = new Date().toISOString();
    run.events.push({ state, message, at: run.updatedAt }); if (run.events.length > 30) run.events.shift();
    await this.save(run);
  }
  async recover() {
    await mkdir(this.folder, { recursive: true });
    for (const file of await readdir(this.folder)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const run = JSON.parse(await readFile(path.join(this.folder, file), 'utf8'));
      if (!uuid.test(run.id) || run.group !== `pixelptx-run-${run.id.replaceAll('-', '').slice(0, 12)}` || run.account !== `pixelptx${run.id.replaceAll('-', '').slice(0, 16)}`) continue;
      this.runs.set(run.id, run);
    }
    // A filesystem lock prevents another local server from duplicating cloud work or recovery.
    if (!this.config) return;
    const lock = path.join(this.folder, 'owner.lock');
    try { this.lockHandle = await open(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(await readFile(lock, 'utf8'));
      let alive = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) { this.unavailable = 'Another PixelPTX server owns the Azure runner. Use that server or close it first.'; return; }
      await unlink(lock); this.lockHandle = await open(lock, 'wx');
    }
    await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid }));
    for (const run of this.runs.values()) if (!terminal(run.state) || run.state === 'cleanup-failed') {
      if (run.subscriptionId !== this.config.subscriptionId) { this.unavailable = 'An unfinished run belongs to another subscription. Restore that configuration and clean up first.'; continue; }
      await this.cleanup(run);
      if (run.state !== 'cleanup-failed') await this.stage(run, 'cancelled', 'Interrupted local run cleaned up. Image results were not retained.');
    }
  }
  async info() {
    await this.ready;
    return { ok: true, configured: Boolean(this.config), available: Boolean(this.config && !this.unavailable), error: this.unavailable || null,
      location: this.config?.location, vmSize: this.config?.vmSize, maxMinutes: 15,
      latest: [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id || null };
  }
  async start(data, compilation) {
    await this.ready; validateGpuInput(data);
    if (!this.config || this.unavailable) throw new Error(this.unavailable || 'Azure is not configured. Run npm run azure:configure -- --subscription <id>, then restart.');
    // The same idempotency key never creates a second run, including after a server restart.
    const previous = [...this.runs.values()].find(run => run.requestId === data.requestId);
    if (previous) return this.snapshot(previous);
    if (this.active || [...this.runs.values()].some(run => run.state === 'cleanup-failed')) throw new Error('A GPU run or unresolved cleanup already exists. Wait or retry its cleanup.');
    const id = randomUUID(), compact = id.replaceAll('-', '');
    const run = { id, requestId: data.requestId, subscriptionId: this.config.subscriptionId, group: `pixelptx-run-${compact.slice(0, 12)}`,
      account: `pixelptx${compact.slice(0, 16)}`, location: this.config.location, vmSize: this.config.vmSize,
      state: 'preparing', message: 'Preparing the generated PTX and image.', startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), width: data.width, height: data.height,
      source: data.source, ptxSha256: createHash('sha256').update(compilation.ptx).digest('hex'), events: [], cleanupConfirmed: false };
    const pool = await makePool(data, compilation, run.expiresAt);
    // Recheck after asynchronous bundle construction to prevent simultaneous requests racing.
    if (this.active) throw new Error('A GPU run is already starting.');
    this.active = run.id; this.runs.set(run.id, run);
    try { await this.save(run); } catch (error) { this.active = null; this.runs.delete(run.id); throw error; }
    run.task = this.execute(run, pool, makeTasks(data.rgb)).finally(() => { this.active = null; });
    return this.snapshot(run);
  }
  async execute(run, pool, tasks) {
    let outcome = 'failed', message = 'GPU run failed.';
    const armApi = suffix => `${this.accountUrl(run)}${suffix}?api-version=${apiVersion}`;
    const check = () => { if (run.cancelling) throw new Error('Run cancelled.'); if (Date.now() >= Date.parse(run.expiresAt)) throw new Error('The 15-minute GPU run deadline expired.'); };
    try {
      check(); await this.stage(run, 'starting', 'Creating a temporary Azure Batch account.');
      // Random resource names plus exact ownership tags make cleanup narrowly scoped.
      await this.client.request('PUT', `${this.groupUrl(run)}?api-version=2024-03-01`, { location: run.location,
        tags: { purpose: 'pixelptx-on-demand', pixelptxRun: run.id, temporary: 'true' } });
      check(); await this.client.request('PUT', armApi(''), { location: run.location, tags: { purpose: 'pixelptx-on-demand', pixelptxRun: run.id },
        properties: { poolAllocationMode: 'BatchService', allowedAuthenticationModes: ['AAD'], publicNetworkAccess: 'Enabled' } });
      while (true) {
        check(); const account = await this.client.request('GET', armApi(''));
        if (enumIs(account?.properties?.provisioningState, 'Succeeded')) break;
        if (enumIs(account?.properties?.provisioningState, 'Failed')) throw new Error('Azure Batch account provisioning failed.');
        await this.sleep(this.pollMs);
      }
      check(); await this.stage(run, 'preparing', 'Validating the Batch pool and image tasks before requesting paid compute.');
      // Validate job/task schemas while the pool has zero nodes, before paid allocation.
      const emptyPool = { properties: { ...pool.properties, scaleSettings: { fixedScale: { targetDedicatedNodes: 0, targetLowPriorityNodes: 0 } } } };
      await this.client.request('PUT', armApi('/pools/filter'), emptyPool);
      const batch = this.batchUrl(run);
      await this.client.request('POST', `${batch}/jobs?api-version=${apiVersion}`, { id: 'filter', poolInfo: { poolId: 'filter' }, usesTaskDependencies: true,
        constraints: { maxWallClockTime: 'PT12M', maxTaskRetryCount: 0 } });
      for (let i = 0; i < tasks.value.length; i += 8) {
        check();
        const added = await this.client.request('POST', `${batch}/jobs/filter/addtaskcollection?api-version=${apiVersion}`, { value: tasks.value.slice(i, i + 8) });
        const rejected = added?.value?.filter(task => !enumIs(task.status, 'success')) || [];
        if (rejected.length) throw new Error(`Azure rejected image tasks: ${rejected.map(task => `${task.taskId}: ${task.error?.code || task.status} ${task.error?.message?.value || task.error?.message || ''}`).join('; ').slice(0, 2000)}`);
        await this.stage(run, 'preparing', `Prepared ${Math.min(i + 8, tasks.value.length)} of ${tasks.value.length} image/execution tasks. No compute requested yet.`);
      }
      while (true) {
        check(); const empty = await this.client.request('GET', armApi('/pools/filter'));
        if (enumIs(empty.properties.allocationState, 'Steady')) break;
        await this.sleep(this.pollMs);
      }
      check(); await this.stage(run, 'allocating', 'Requesting one Spot T4. Availability is not guaranteed.');
      await this.client.request('POST', `${batch}/pools/filter/enableautoscale?api-version=${apiVersion}`, {
        autoScaleFormula: pool.properties.scaleSettings.autoScale.formula,
        autoScaleEvaluationInterval: pool.properties.scaleSettings.autoScale.evaluationInterval
      });
      let nodeId;
      while (true) {
        check(); const status = await this.client.request('GET', armApi('/pools/filter'));
        const properties = status.properties;
        const errors = properties.resizeErrors || properties.resizeOperationStatus?.errors;
        if (errors?.length) throw new Error(`GPU allocation: ${errors.map(error => error.message || error.code).join('; ')}`);
        if (properties.autoScaleRun?.error) throw new Error('Azure rejected the GPU expiry formula.');
        if (properties.currentDedicatedNodes > 0) throw new Error('Unexpected dedicated node; deleting the run.');
        if (properties.currentLowPriorityNodes > 0) {
          const nodes = await this.client.request('GET', `${this.batchUrl(run)}/pools/filter/nodes?api-version=${apiVersion}`);
          const node = nodes.value?.[0];
          if (enumIs(node?.state, 'preempted')) throw new Error('Azure reclaimed the Spot GPU. Run again when capacity is available.');
          if (enumIs(node?.startTaskInfo?.state, 'completed')) {
            nodeId = node.id;
            if (node.startTaskInfo.exitCode !== 0) {
              const detail = await this.client.request('GET', `${this.batchUrl(run)}/pools/filter/nodes/${encodeURIComponent(nodeId)}/files/startup/wd/result.json?api-version=${apiVersion}`);
              throw new Error(detail?.error || 'The C++ GPU runner could not be built.');
            }
            break;
          }
          if (run.state !== 'building') await this.stage(run, 'building', 'GPU allocated. Starting the node and building the C++ CUDA runner.');
          if (enumIs(node?.state, 'unusable')) throw new Error('The allocated GPU node is unusable.');
        }
        await this.sleep(this.pollMs);
      }
      check(); await this.stage(run, 'running', 'Uploading RGB channels in bounded tasks, then executing original and optimized PTX.');
      while (true) {
        check();
        const status = await this.client.request('GET', `${batch}/jobs/filter/tasks?api-version=${apiVersion}`);
        const failed = status.value?.find(task => enumIs(task.state, 'completed') && task.executionInfo?.exitCode !== 0);
        if (failed && failed.id !== 'execute') throw new Error('An image upload task failed. No complete GPU result is available.');
        if (status.value?.find(task => task.id === 'execute' && enumIs(task.state, 'completed'))) break;
        await this.sleep(this.pollMs);
      }
      check(); await this.stage(run, 'collecting', 'Collecting NVIDIA output and CPU reference comparisons.');
      const result = await this.client.request('GET', `${batch}/jobs/filter/tasks/execute/files/wd/result.json?api-version=${apiVersion}`);
      if (!result?.ok) throw new Error(result?.error || 'GPU runner did not produce a successful result.');
      if (result.backend !== 'cuda-driver-ptx' || !Array.isArray(result.values) || result.values.length !== run.width * run.height * 3 ||
        result.values.some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('Invalid GPU result payload.');
      run.result = result;
      outcome = result.correct ? 'succeeded' : 'failed';
      message = result.correct ? 'Generated PTX executed on NVIDIA hardware and matched the CPU reference.' : 'GPU execution completed with correctness failures. Inspect the comparison report.';
    } catch (error) { outcome = run.cancelling ? 'cancelled' : 'failed'; message = error.message; }
    finally {
      run.outcome = outcome; run.outcomeMessage = message;
      await this.cleanup(run);
      if (run.state !== 'cleanup-failed') await this.stage(run, outcome, `${message} Temporary Azure resources deleted.`);
    }
  }
  async cleanup(run) {
    // A full disk must never prevent cloud cleanup.
    try { await this.stage(run, 'deleting', 'Deleting the temporary GPU and its resource group. Charges can continue during deletion.'); }
    catch { run.state = 'deleting'; }
    try {
      if (run.subscriptionId !== this.config.subscriptionId) throw new Error('Cleanup subscription does not match configuration.');
      const url = `${this.groupUrl(run)}?api-version=2024-03-01`;
      let group;
      try { group = await this.client.request('GET', url); } catch (error) { if (error.status !== 404) throw error; }
      if (group) {
        if (group.tags?.purpose !== 'pixelptx-on-demand' || group.tags?.pixelptxRun !== run.id) throw new Error('Resource ownership tags do not match; cleanup refused.');
        // Release the paid pool explicitly before removing its enclosing account/group.
        // Still attempt group deletion if this request fails or the account is already deleting.
        try { await this.client.request('DELETE', `${this.accountUrl(run)}/pools/filter?api-version=${apiVersion}`); }
        catch { /* Group deletion below remains the authoritative cleanup. */ }
        await this.client.request('DELETE', url);
        const deadline = Date.now() + 10 * 60000;
        while (true) {
          try { await this.client.request('GET', url); }
          catch (error) { if (error.status === 404) break; throw error; }
          if (Date.now() > deadline) throw new Error('Azure deletion is still pending after ten minutes. Retry cleanup.');
          await this.sleep(this.pollMs);
        }
      }
      run.cleanupConfirmed = true;
    } catch (error) {
      run.cleanupConfirmed = false;
      run.state = 'cleanup-failed'; run.message = `Cleanup needs attention: ${error.message} Resource group: ${run.group}`;
      try { await this.stage(run, 'cleanup-failed', run.message); } catch { /* Keep the failure visible in memory. */ }
    }
  }
  async get(id) { await this.ready; const run = this.runs.get(id); if (!run) throw new Error('GPU run not found.'); return this.snapshot(run); }
  async cancel(id) { await this.ready; const run = this.runs.get(id); if (!run) throw new Error('GPU run not found.'); if (!terminal(run.state) && run.state !== 'deleting') { run.cancelling = true; await this.stage(run, 'cancelling', 'Cancelling the run and removing its compute.'); } return this.snapshot(run); }
  async retryCleanup(id) {
    await this.ready; const run = this.runs.get(id);
    if (!run || run.state !== 'cleanup-failed' || this.active || !this.config || this.unavailable) throw new Error('Cleanup is unavailable or another run is active.');
    this.active = id;
    run.task = (async () => { await this.cleanup(run); if (run.cleanupConfirmed) await this.stage(run, run.outcome || 'cancelled', 'Temporary Azure resources deleted.'); })().finally(() => { this.active = null; });
    return this.snapshot(run);
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = this.finishClose();
    return this.closing;
  }
  async finishClose() {
    await this.ready;
    for (const run of this.runs.values()) if (run.task && !terminal(run.state)) { run.cancelling = true; await run.task; }
    if (this.lockHandle) { await this.lockHandle.close(); await unlink(path.join(this.folder, 'owner.lock')); this.lockHandle = null; }
  }
}
