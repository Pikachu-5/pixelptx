import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GpuRuns, loadConfig, validateGpuInput } from './azure.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exeName = process.platform === 'win32' ? 'pixelptx.exe' : 'pixelptx';
const executable = [path.join(root, 'build', exeName), path.join(root, 'build', 'Release', exeName)].find(existsSync);
function findTool(name) {
  const filename = process.platform === 'win32' ? `${name}.exe` : name;
  const locations = [path.join(root, '.tools', 'cuda', 'bin'), process.env.CUDA_PATH && path.join(process.env.CUDA_PATH, 'bin'), ...(process.env.PATH || '').split(path.delimiter)];
  return locations.filter(Boolean).map(folder => path.join(folder, filename)).find(existsSync) || null;
}
function processOutput(command, args, input, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Compilation timed out. Try a smaller filter.')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    for (const [stream, key] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', data => {
      bytes += data.length;
      if (bytes > 24 * 1024 * 1024) { child.kill(); reject(new Error('Compiler output exceeded the size limit.')); return; }
      if (key === 'out') stdout += data; else stderr += data;
    });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function compiler(mode, input) {
  if (!executable) throw new Error('Compiler executable is missing. Run npm run build, then restart the server.');
  const result = await processOutput(executable, [mode], input);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`Compiler did not return JSON. ${result.stderr.slice(0, 300)}`); }
}
// JSON.stringify turns -0 into 0. Preserve float32 signed zero across the API.
function floatSafeJson(value) {
  if (typeof value === 'number' && Object.is(value, -0)) return '-0.0';
  if (Array.isArray(value)) return `[${value.map(floatSafeJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}:${floatSafeJson(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(floatSafeJson(value));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Request exceeds 8 MB. Use a smaller image.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
let active = 0;
export function createServer({ gpu = new GpuRuns() } = {}) {
  const server = http.createServer(async (req, res) => {
    // Bind locally and reject cross-origin browser requests, including DNS rebinding.
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(res, 403, { ok: false, error: 'Use localhost to access PixelPTX.' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(res, 403, { ok: false, error: 'Cross-origin requests are not allowed.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { return send(res, 400, { ok: false, error: 'Invalid URL.' }); }
    if (url.pathname.startsWith('/api/gpu')) {
      try {
        if (req.method === 'GET' && url.pathname === '/api/gpu/config') return send(res, 200, await gpu.info());
        const match = /^\/api\/gpu\/runs\/([0-9a-f-]{36})(?:\/(cancel|cleanup))?$/.exec(url.pathname);
        if (req.method === 'GET' && match && !match[2]) return send(res, 200, await gpu.get(match[1]));
        if (req.method === 'POST') {
          if (req.headers['x-pixelptx-cloud'] !== 'explicit-run') return send(res, 403, { ok: false, error: 'Use the explicit GPU controls to start or change a cloud run.' });
          if (match?.[2] === 'cancel') return send(res, 202, await gpu.cancel(match[1]));
          if (match?.[2] === 'cleanup') return send(res, 202, await gpu.retryCleanup(match[1]));
          if (url.pathname === '/api/gpu/runs') {
            const data = await body(req); validateGpuInput(data);
            const compiled = await compiler('--json', data.source);
            if (!compiled.ok) return send(res, 422, compiled);
            return send(res, 202, await gpu.start(data, compiled));
          }
        }
        return send(res, 404, { ok: false, error: 'GPU endpoint not found.' });
      } catch (error) { return send(res, 400, { ok: false, error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, {
      ok: true, compiler: Boolean(executable), ptxas: Boolean(findTool('ptxas')), nvdisasm: Boolean(findTool('nvdisasm')),
      execution: 'CPU IR interpreter + original AST reference', target: 'sm_75', ptxVersion: '7.0', gpuExecution: false
    });
    if (req.method === 'POST' && ['/api/compile', '/api/run', '/api/trace', '/api/assemble'].includes(url.pathname)) {
      if (active >= 3) return send(res, 429, { ok: false, error: 'Compiler is busy. Try again in a moment.' });
      active++;
      try {
        const data = await body(req);
        if (typeof data.source !== 'string' || Buffer.byteLength(data.source) > 8192) throw new Error('Source must be a string of at most 8192 bytes.');
        // Source spans are byte offsets. The language intentionally uses ASCII.
        if (/[^\x00-\x7f]/.test(data.source)) throw new Error('Filter source supports ASCII characters only.');
        if (url.pathname === '/api/compile') {
          const start = performance.now();
          const result = await compiler('--json', data.source);
          result.compileMs = performance.now() - start;
          return send(res, result.ok ? 200 : 422, result);
        }
        if (url.pathname === '/api/run' || url.pathname === '/api/trace') {
          const pixels = url.pathname === '/api/trace' ? [data.pixel] : data.pixels;
          if (!Array.isArray(pixels) || pixels.length < 1 || pixels.length > 786432 || pixels.some(p => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1))
            throw new Error('Pixels must be an array of 1–786432 finite numbers in [0, 1].');
          const protocol = `${Buffer.byteLength(data.source)}\n${data.source}\n${pixels.length}\n${pixels.join(' ')}`;
          const start = performance.now();
          const result = await compiler(url.pathname === '/api/trace' ? '--trace' : '--run', protocol);
          result.processMs = performance.now() - start;
          return send(res, result.ok ? 200 : 422, result);
        }
        const ptxas = findTool('ptxas');
        if (!ptxas) return send(res, 409, { ok: false, error: 'PTXAS is not installed. Export the PTX now, or install NVIDIA CUDA command-line tools and restart PixelPTX.' });
        const c = await compiler('--json', data.source);
        if (!c.ok) return send(res, 422, c);
        const folder = await mkdtemp(path.join(tmpdir(), 'pixelptx-'));
        try {
          const ptx = path.join(folder, 'filter.ptx'), cubin = path.join(folder, 'filter.cubin');
          await writeFile(ptx, data.unoptimized ? c.beforePtx : c.ptx);
          const assembled = await processOutput(ptxas, ['-arch=sm_75', '-v', ptx, '-o', cubin], '');
          if (assembled.code !== 0) return send(res, 422, { ok: false, error: assembled.stderr || assembled.stdout });
          const binary = await readFile(cubin);
          const nvdisasm = findTool('nvdisasm');
          const disassembly = nvdisasm ? await processOutput(nvdisasm, ['-c', cubin], '') : null;
          return send(res, 200, { ok: true, log: assembled.stderr + assembled.stdout, bytes: binary.length,
            cubin: binary.toString('base64'), sass: disassembly?.code === 0 ? disassembly.stdout : null,
            disassemblyError: disassembly && disassembly.code !== 0 ? disassembly.stderr : null, target: 'sm_75', gpuExecuted: false });
        } finally { await rm(folder, { recursive: true, force: true }); }
      } catch (error) { send(res, 400, { ok: false, error: error.message }); }
      finally { active--; }
      return;
    }
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed.' });
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/gpu.js': ['gpu.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/tokens.css': ['tokens.css', 'text/css'] };
    const resource = files[url.pathname];
    if (!resource) return send(res, 404, { ok: false, error: 'Not found.' });
    try {
      const content = await readFile(path.join(root, 'web', resource[0]));
      res.writeHead(200, { 'Content-Type': `${resource[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      res.end(content);
    } catch { send(res, 500, { ok: false, error: 'UI file missing.' }); }
  });
  server.gpu = gpu;
  server.on('close', () => { gpu.close().catch(error => console.error(`Azure cleanup: ${error.message}`)); });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const gpu = new GpuRuns({ config: await loadConfig() });
  const server = createServer({ gpu });
  server.on('error', error => { console.error(`PixelPTX could not start: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`PixelPTX → http://127.0.0.1:${port}\nC++ compiler: ${executable ? 'ready' : 'missing; run npm run build'}\nPreview: CPU reference + IR. Azure GPU runs are explicit and temporary.`));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return; stopping = true;
    console.log('Stopping PixelPTX; waiting for any Azure cleanup…');
    await gpu.close(); server.close();
  });
}
