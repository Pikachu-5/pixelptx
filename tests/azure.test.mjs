import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { AzureTransport, GpuRuns, makePool, makeTasks, validateGpuInput } from '../scripts/azure.mjs';
import { createServer } from '../scripts/server.mjs';

const config = { subscriptionId: '11111111-1111-1111-1111-111111111111', location: 'centralindia', vmSize: 'Standard_NC4as_T4_v3' };
const input = () => ({ source: 'pixel', requestId: randomUUID(), consent: true, width: 1, height: 1, rgb: Buffer.from([0, 128, 255]).toString('base64') });
const compilation = { ptx: '// optimized', beforePtx: '// original' };
const missing = () => Object.assign(new Error('not found'), { status: 404 });
class FakeAzure {
  groups = new Map(); calls = []; poolFailure = false; deleteFailure = false; mismatchTags = false;
  async request(method, url, body) {
    this.calls.push({ method, url, body });
    if (/\/resourceGroups\/[^/?]+\?/.test(url)) {
      const key = url.split('?')[0];
      if (method === 'PUT') { this.groups.set(key, body); return body; }
      if (method === 'DELETE') { if (this.deleteFailure) throw new Error('simulated cleanup outage'); this.groups.delete(key); return null; }
      if (!this.groups.has(key)) throw missing();
      return this.mismatchTags ? { tags: {} } : this.groups.get(key);
    }
    if (url.includes('/files/')) return { ok: true, correct: true, backend: 'cuda-driver-ptx', values: [0, .5, 1], device: 'test double' };
    if (url.includes('/jobs/filter/tasks?')) return { value: [{ id: 'execute', state: 'Completed', executionInfo: { exitCode: 0 } }] };
    if (url.includes('/addtaskcollection')) return { value: body.value.map(task => ({ taskId: task.id, status: 'Success' })) };
    if (url.includes('/nodes?')) return { value: [{ id: 'node-1', state: 'idle', startTaskInfo: { state: 'completed', exitCode: 0 } }] };
    if (url.includes('/pools/filter')) {
      if (method === 'PUT' && this.poolFailure) throw new Error('simulated quota rejection');
      return { properties: { allocationState: 'Steady', currentLowPriorityNodes: 1, currentDedicatedNodes: 0 } };
    }
    return { properties: { provisioningState: 'Succeeded' } };
  }
}
async function fixture(t, client = new FakeAzure()) {
  const folder = await mkdtemp(path.join(tmpdir(), 'pixelptx-azure-test-'));
  const gpu = new GpuRuns({ config, transport: client, folder, sleep: async () => {}, pollMs: 0 });
  await gpu.ready;
  t.after(async () => { await gpu.close(); await rm(folder, { recursive: true, force: true }); });
  return { gpu, client, folder };
}
async function done(gpu, id) { await gpu.runs.get(id).task; return gpu.get(id); }

test('GPU input requires cost/upload consent, correct dimensions, canonical base64, and a request ID', () => {
  assert.equal(validateGpuInput(input()).length, 3);
  for (const change of [{ consent: false }, { requestId: 'x' }, { source: 'π' }, { width: 353 }, { rgb: 'AA==' }, { rgb: 'ABCA=' }, { height: 0 }])
    assert.throws(() => validateGpuInput({ ...input(), ...change }));
});
test('transport uses Batch OData content type and rejects unexpected credential destinations', async t => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { seen.push(options.headers['Content-Type']); return new Response('{}', { status: 200 }); });
  const client = new AzureTransport(config.subscriptionId); client.token = async () => 'test-token';
  await client.request('POST', 'https://pixelptx0123456789abcdef.centralindia.batch.azure.com/jobs?api-version=2025-06-01', {});
  await client.request('PUT', 'https://management.azure.com/subscriptions/test', {});
  assert.deepEqual(seen, ['application/json;odata=minimalmetadata', 'application/json']);
  await assert.rejects(client.request('POST', 'https://example.com/jobs', {}), /Unexpected Azure service URL/);
});
test('pool has one expiring Spot target, no dedicated fallback, and exact generated PTX', async () => {
  const data = input(), expires = '2026-10-21T17:00:00Z';
  const pool = await makePool(data, compilation, expires);
  assert.match(pool.properties.scaleSettings.autoScale.formula, /\$TargetDedicatedNodes=0/);
  assert.match(pool.properties.scaleSettings.autoScale.formula, /\? 1 : 0/);
  assert.match(pool.properties.scaleSettings.autoScale.formula, /21 Oct 2026 17:00:00 GMT/);
  assert.equal(pool.properties.scaleSettings.autoScale.evaluationInterval, 'PT5M');
  const encoded = pool.properties.startTask.environmentSettings.map(item => item.value).join('');
  const bundle = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')));
  assert.equal(Buffer.from(bundle['optimized.ptx'], 'base64').toString(), compilation.ptx);
  assert.equal(bundle['input.u8'], undefined);
  assert.ok(JSON.stringify(pool.properties.startTask).length < 28000);
  const tasks = makeTasks(data.rgb).value;
  assert.match(tasks[0].commandLine, new RegExp(data.rgb));
  assert.deepEqual(tasks.at(-1).dependsOn.taskIds, [tasks[0].id]);
  assert.equal(pool.properties.startTask.maxTaskRetryCount, 0);
});
test('full-size RGB transfer stays in bounded, dependency-ordered native tasks', () => {
  const bytes = Buffer.alloc(352 * 256 * 3); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const tasks = makeTasks(bytes.toString('base64')).value;
  assert.ok(tasks.length < 100);
  assert.ok(tasks.every(task => task.commandLine.length < 10000));
  assert.deepEqual(tasks.at(-1).dependsOn.taskIds, tasks.slice(0, -1).map(task => task.id));
  assert.ok(Buffer.byteLength(JSON.stringify({ value: tasks })) < 700000);
});
test('success collects GPU results, confirms deletion, deduplicates replay, and redacts image history', async t => {
  const { gpu, client, folder } = await fixture(t); const data = input();
  const first = await gpu.start(data, compilation), result = await done(gpu, first.id);
  assert.equal(result.state, 'succeeded'); assert.equal(result.cleanupConfirmed, true); assert.equal(client.groups.size, 0);
  assert.deepEqual(result.result.values, [0, .5, 1]);
  const job = client.calls.find(call => call.method === 'POST' && /\/jobs\?/.test(call.url));
  assert.equal(job.body.usesTaskDependencies, true);
  assert.equal(job.body.useTaskDependencies, undefined);
  const allocated = client.calls.findIndex(call => call.url.includes('/enableautoscale'));
  assert.ok(client.calls.findIndex(call => call.url.includes('/addtaskcollection')) < allocated);
  const pool = client.calls.find(call => call.method === 'PUT' && call.url.includes('/pools/filter'));
  assert.deepEqual(pool.body.properties.scaleSettings.fixedScale, { targetDedicatedNodes: 0, targetLowPriorityNodes: 0 });
  assert.equal((await gpu.start(data, compilation)).id, first.id);
  assert.equal(client.calls.filter(call => call.method === 'PUT' && /\/resourceGroups\/[^/?]+\?/.test(call.url)).length, 1);
  const saved = JSON.parse(await readFile(path.join(folder, `${first.id}.json`), 'utf8'));
  assert.equal(saved.result, undefined); assert.equal(saved.diagnostics.values, undefined); assert.equal(saved.rgb, undefined);
});
test('quota rejection still deletes all owned resources', async t => {
  const client = new FakeAzure(); client.poolFailure = true;
  const { gpu } = await fixture(t, client); const started = await gpu.start(input(), compilation);
  const result = await done(gpu, started.id);
  assert.equal(result.state, 'failed'); assert.match(result.message, /quota rejection/); assert.equal(result.cleanupConfirmed, true); assert.equal(client.groups.size, 0);
});
test('cleanup failure is visible, blocks new compute, and can be retried', async t => {
  const { gpu, client } = await fixture(t); client.deleteFailure = true;
  const first = await gpu.start(input(), compilation), result = await done(gpu, first.id);
  assert.equal(result.state, 'cleanup-failed'); assert.equal(result.cleanupConfirmed, false);
  await assert.rejects(gpu.start(input(), compilation), /unresolved cleanup/);
  client.deleteFailure = false; await gpu.retryCleanup(first.id);
  assert.equal((await done(gpu, first.id)).cleanupConfirmed, true);
});
test('ownership mismatch refuses deletion rather than deleting unrelated resources', async t => {
  const { gpu, client } = await fixture(t); client.mismatchTags = true;
  const first = await gpu.start(input(), compilation), result = await done(gpu, first.id);
  assert.equal(result.state, 'cleanup-failed'); assert.match(result.message, /ownership/);
  assert.equal(client.calls.some(call => call.method === 'DELETE'), false);
});
test('concurrent submission creates at most one run', async t => {
  const { gpu, client } = await fixture(t);
  const results = await Promise.allSettled([gpu.start(input(), compilation), gpu.start(input(), compilation)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await gpu.runs.values().next().value.task;
  assert.equal(client.calls.filter(call => call.method === 'PUT' && call.url.includes('/pools/filter')).length, 1);
});
test('cancellation removes compute and never turns into a second allocation', async t => {
  const { gpu, client } = await fixture(t);
  const first = await gpu.start(input(), compilation); await gpu.cancel(first.id);
  const result = await done(gpu, first.id);
  assert.equal(result.state, 'cancelled'); assert.equal(client.groups.size, 0); assert.equal(result.cleanupConfirmed, true);
});
test('server restart cleans interrupted owned runs before accepting more work', async t => {
  const { gpu, client, folder } = await fixture(t);
  const first = await gpu.start(input(), compilation); await done(gpu, first.id); await gpu.close();
  const file = path.join(folder, `${first.id}.json`), saved = JSON.parse(await readFile(file, 'utf8'));
  saved.state = 'running'; saved.cleanupConfirmed = false; await writeFile(file, JSON.stringify(saved));
  client.groups.set(gpu.groupUrl(saved), { tags: { purpose: 'pixelptx-on-demand', pixelptxRun: saved.id } });
  const recovered = new GpuRuns({ config, transport: client, folder, sleep: async () => {} });
  await recovered.ready;
  assert.equal((await recovered.get(first.id)).state, 'cancelled'); assert.equal(client.groups.size, 0);
  await recovered.close();
});
test('cloud HTTP endpoints reject cross-origin and non-explicit starts without Azure mutations', async t => {
  const { gpu, client } = await fixture(t);
  const server = createServer({ gpu }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/gpu/config`)).status, 200);
  for (const headers of [{}, { 'X-PixelPTX-Cloud': 'explicit-run', Origin: 'https://example.com' }]) {
    const response = await fetch(`${base}/api/gpu/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input()) });
    assert.equal(response.status, 403);
  }
  assert.equal(client.calls.length, 0);
});
