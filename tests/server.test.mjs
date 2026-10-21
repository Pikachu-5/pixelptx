import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../scripts/server.mjs';

const server = createServer();
let base;
before(async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise(resolve => server.close(resolve)));
async function post(endpoint, body, headers = {}) {
  const response = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { response, data: await response.json() };
}
test('serves the local workbench with a CSP and compiler health', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /PixelPTX/);
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.compiler, true); assert.equal(health.gpuExecution, false);
});
test('compiles using the C++ front end and returns source-mapped PTX', async () => {
  const source = 'out = clamp(pixel * 1.0 + (0.1 + 0.15), 0, 1);';
  const { response, data } = await post('compile', { source });
  assert.equal(response.status, 200); assert.equal(data.source, source);
  assert.ok(data.rewrites.some(r => r.rule === 'Constant folding'));
  assert.ok(data.rewrites.some(r => r.rule === 'Multiplicative identity'));
  const lines = data.ptx.split('\n');
  for (const instruction of data.ir) {
    assert.ok(lines[instruction.line - 1].includes(`%f${instruction.dest}`));
    assert.ok(instruction.start >= 0 && instruction.end <= source.length);
  }
});
test('executes float channels in C++, compares original AST, returns register trace', async () => {
  const source = 'out = clamp(pixel * 1.0 + 0.25, 0, 1);';
  const { data } = await post('run', { source, pixels: [0, .25, .5, .75, 1] });
  assert.deepEqual(data.values, [.25, .5, .75, 1, 1]);
  assert.equal(data.mismatches, 0); assert.equal(data.checked, 5); assert.equal(data.backend, 'cpu-ir');
  const { data: trace } = await post('trace', { source, pixel: .5 });
  assert.equal(trace.trace.at(-1), .75); assert.equal(trace.values[0], .75);
});
test('preserves multiline source byte offsets and exact negative-zero semantics', async () => {
  const { data } = await post('compile', { source: '// multiline\nout = pixel + ;' });
  assert.equal(data.ok, false); assert.equal(data.start, 27);
  const { data: result } = await post('run', { source: 'pixel * -0.0', pixels: [0, .5] });
  assert.equal(result.mismatches, 0); assert.ok(Object.is(result.values[1], -0));
});
test('reports diagnostics and rejects unsupported names, oversized and invalid data', async () => {
  const invalid = await post('compile', { source: 'out = unknown(pixel);' });
  assert.equal(invalid.response.status, 422); assert.match(invalid.data.error, /Unknown name/);
  assert.equal((await post('compile', { source: ' '.repeat(8193) })).response.status, 400);
  assert.equal((await post('compile', { source: 'π' })).response.status, 400);
  for (const pixels of [[-1], [2], [null], ['0.5'], [], {}]) assert.equal((await post('run', { source: 'pixel', pixels })).response.status, 400);
});
test('rejects cross-origin calls, arbitrary static paths, and unsupported methods', async () => {
  assert.equal((await post('compile', { source: 'pixel' }, { Origin: 'https://example.com' })).response.status, 403);
  assert.equal((await fetch(`${base}/src/compiler.cpp`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'DELETE' })).status, 405);
});
test('binary stage either assembles real PTX or reports the missing tool', async () => {
  const health = await (await fetch(`${base}/api/health`)).json();
  const { response, data } = await post('assemble', { source: 'clamp(pixel * 1 + 0.25, 0, 1)' });
  if (!health.ptxas) { assert.equal(response.status, 409); assert.match(data.error, /PTXAS/); return; }
  assert.equal(response.status, 200, data.error);
  assert.equal(Buffer.from(data.cubin, 'base64').subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(data.gpuExecuted, false); assert.ok(data.bytes > 0);
  if (health.nvdisasm) assert.match(data.sass, /pixel_filter/);
});
test('PTXAS accepts every supported operation, original and optimized kernels', async t => {
  const health = await (await fetch(`${base}/api/health`)).json();
  if (!health.ptxas) { t.skip('NVIDIA PTXAS is optional and not installed.'); return; }
  for (const source of ['pixel', '.25', 'abs(-pixel)', 'min(pixel, .75)', 'max(pixel, .25)',
    'clamp((pixel - .5) * 1.8 + .5, 0, 1)', 'pixel * (0.5 + 0.5) + (0.1 + 0.15)',
    'min(-0.0, pixel)', 'pixel * 0.00000001']) {
    for (const unoptimized of [false, true]) {
      const { response, data } = await post('assemble', { source, unoptimized });
      assert.equal(response.status, 200, `${source}: ${data.error}`);
      assert.equal(Buffer.from(data.cubin, 'base64').subarray(0, 4).toString('hex'), '7f454c46');
    }
  }
});
