import { initGpu } from './gpu.js';
const $ = id => document.getElementById(id);
let gpuControls;
const source = $('source');
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const presets = {
  brightness: 'out = clamp(\n  pixel * 1.0 + 0.25,\n  0.0, 1.0\n);',
  contrast: 'out = clamp(\n  (pixel - 0.5) * 1.8 + 0.5,\n  0.0, 1.0\n);',
  invert: 'out = 1.0 - pixel;',
  fold: 'out = clamp(\n  pixel * (0.5 + 0.5)\n    + (0.1 + 0.15),\n  0.0, 1.0\n);'
};
const stages = {
  ast: ['An expression becomes a tree.', 'Operators become nodes; their inputs become branches. Select a node to locate its source.'],
  optimizer: ['Optimization, made visible.', 'Each rewrite is recorded by the C++ optimizer.'],
  ir: ['Follow a value through registers.', 'Step through the register IR on the CPU. This is not PTX or GPU execution.'],
  ptx: ['Instructions for NVIDIA’s compiler.', 'A complete PTX kernel, including indexing, memory access, and bounds checks.'],
  binary: ['From virtual ISA to GPU binary.', 'NVIDIA’s offline tools can assemble PTX and disassemble the resulting CUBIN.']
};
const state = {
  stage: 'optimizer', compilation: null, health: null, dirty: true, revision: 0,
  compileToken: 0, renderToken: 0, traceToken: 0, imageRevision: 0,
  before: false, pixel: .4, trace: null, step: -1, binary: null, busy: false,
  input: null, output: null, imageName: 'Procedural color study · synthetic'
};
let compileController, traceTimer;
function status(message, tone = 'info') { $('status').textContent = message; $('status').dataset.tone = tone; }
function current() { return Boolean(state.compilation && !state.dirty && state.compilation.source === source.value); }
function number(value, digits = 3) {
  if (value === null || !Number.isFinite(value)) return 'nonfinite';
  if (Object.is(value, -0)) return '-0.000';
  return Math.abs(value) >= 10000 || (value !== 0 && Math.abs(value) < .0001) ? value.toExponential(3) : value.toFixed(digits);
}
async function api(endpoint, data, signal) {
  const timeout = AbortSignal.timeout(30000);
  const response = await fetch(`/api/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  const result = await response.json();
  if (!response.ok || !result.ok) { const error = new Error(result.error || 'The local compiler could not finish.'); Object.assign(error, result); throw error; }
  return result;
}
function updateActions() {
  gpuControls?.refresh();
  $('compile').disabled = state.busy;
  $('compile').setAttribute('aria-busy', String(state.busy));
  $('compile').querySelector('span').textContent = state.busy ? 'Compiling…' : 'Compile & run';
  $('export-ptx').disabled = !current();
  $('save-image').disabled = !current() || !state.output;
  $('source-size').textContent = `${new TextEncoder().encode(source.value).length} bytes`;
}
function markDirty() {
  state.revision++; state.dirty = true; state.trace = null; state.binary = null; state.busy = false;
  compileController?.abort();
  $('diagnostic').textContent = ''; source.removeAttribute('aria-invalid');
  $('preview-state').textContent = 'Source changed · compile to update'; $('preview-state').classList.add('stale');
  $('image-overlay').textContent = 'Previous output · source changed'; $('image-overlay').hidden = false;
  status('Source changed. Compile to update the explorer.');
  try { localStorage.setItem('pixelptx.source', source.value); } catch { /* Storage may be disabled. */ }
  updateActions();
  if (state.compilation) renderStage();
}
function sourceLocation(start, end) {
  if (!current()) { status('Compile the edited source before using source mappings.'); return; }
  source.focus({ preventScroll: true }); source.setSelectionRange(start, end);
  const line = source.value.slice(0, start).split('\n').length;
  status(`Source mapping: line ${line}, characters ${start + 1}–${Math.max(start + 1, end)}.`);
}
function download(content, name, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function wireMappings(container) {
  container.querySelectorAll('[data-start]').forEach(button => button.addEventListener('click', () => sourceLocation(Number(button.dataset.start), Number(button.dataset.end))));
}
function compareView() {
  const c = state.compilation, stats = c.stats;
  const removed = stats.beforeInstructions - stats.afterInstructions;
  $('inspector-body').innerHTML = `
    <div class="expression-comparison"><div class="expression-block"><span>Original expression</span><code>${escape(c.expression)}</code></div><span aria-hidden="true">→</span><div class="expression-block"><span>Optimized expression</span><code>${escape(c.optimized)}</code></div></div>
    <div class="optimization-stats"><div><strong>${stats.beforeInstructions} → ${stats.afterInstructions}</strong><span>Expression PTX instructions</span></div><div><strong>${stats.beforeNodes} → ${stats.afterNodes}</strong><span>AST nodes</span></div><div><strong class="savings">${removed}</strong><span>Instructions removed</span></div></div>
    ${c.rewrites.length ? c.rewrites.map((r, i) => `<div class="rewrite"><span class="rewrite-number">${i + 1}</span><div><h3>${escape(r.rule)}</h3><code>${escape(r.before)} → ${escape(r.after)}</code><br><button class="button quiet" data-start="${r.start}" data-end="${r.end}">Locate in source</button></div></div>`).join('') : '<p class="inspector-note">No safe rewrites apply. The original expression is preserved.</p>'}
    <p class="inspector-note">Counts include expression loads and moves, and exclude the fixed kernel wrapper. Fewer PTX instructions do not establish a GPU speedup. Addition by zero and multiplication by zero are preserved.</p>`;
  wireMappings($('inspector-body'));
}
function toggleMarkup() {
  return `<div class="segmented" aria-label="Compilation version"><button data-version="before" aria-pressed="${state.before}">Original</button><button data-version="after" aria-pressed="${!state.before}">Optimized</button></div>`;
}
function wireVersions() {
  document.querySelectorAll('[data-version]').forEach(button => button.addEventListener('click', () => { state.before = button.dataset.version === 'before'; renderStage(); }));
}
function treeView() {
  const root = state.before ? state.compilation.ast : state.compilation.optimizedAst;
  const nodes = [], edges = [];
  let leaf = 0, maxDepth = 0;
  function visit(node, depth) {
    const children = node.children.map(child => visit(child, depth + 1));
    const x = children.length ? children.reduce((sum, child) => sum + child.x, 0) / children.length : 60 + leaf++ * 110;
    const item = { ...node, x, y: 20 + depth * 76 };
    maxDepth = Math.max(maxDepth, depth); nodes.push(item);
    children.forEach(child => edges.push([item, child]));
    return item;
  }
  visit(root, 0);
  const width = Math.max(320, leaf * 110 + 10), height = (maxDepth + 1) * 76 + 15;
  $('inspector-body').innerHTML = `<div class="view-toolbar">${toggleMarkup()}<span class="small-note">${nodes.length} nodes · click to trace source</span></div><div class="tree-viewport"><div class="tree" style="width:${width}px;height:${height}px"><svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${edges.map(([a, b]) => `<path d="M${a.x} ${a.y + 38} C${a.x} ${a.y + 60} ${b.x} ${b.y - 22} ${b.x} ${b.y}"/>`).join('')}</svg>${nodes.map(node => `<button class="tree-node" style="left:${node.x}px;top:${node.y}px" data-kind="${node.op}" data-start="${node.start}" data-end="${node.end}" title="${escape(node.label)} · source characters ${node.start + 1}–${node.end}" aria-label="${escape(node.label)}, source characters ${node.start + 1} to ${node.end}">${escape(node.label.length > 10 ? Number(node.label).toPrecision(3) : node.label)}</button>`).join('')}</div></div><p class="inspector-note">The tree encodes precedence and function arguments. Parentheses guide parsing; they do not need their own AST nodes.</p>`;
  wireVersions(); wireMappings($('inspector-body'));
}
function irOperation(inst) {
  if (inst.op === 'const') return `const ${number(inst.value, 5)}`;
  if (inst.op === 'pixel') return 'load pixel';
  return `${inst.op} ${inst.args.map(i => `%f${i}`).join(', ')}`;
}
function irView() {
  const ir = state.compilation.ir;
  $('inspector-body').innerHTML = `<div class="view-toolbar"><div class="trace-summary">pixel = <strong>${number(state.pixel)}</strong><span id="step-label">${state.step < 0 ? 'Ready to step' : `Instruction ${state.step + 1} of ${ir.length}`}</span></div><div class="trace-controls"><button id="trace-reset" class="button outline">Reset</button><button id="trace-step" class="button primary" ${!current() || !state.trace || state.step === ir.length - 1 ? 'disabled' : ''}>Step instruction →</button></div></div><div class="trace-list">${ir.map((inst, i) => `<button class="trace-row ${i === state.step ? 'current' : ''}" data-instruction="${i}" data-start="${inst.start}" data-end="${inst.end}"><span class="register">%f${inst.dest}</span><span class="operation">${escape(irOperation(inst))}</span><output>${state.trace && i <= state.step ? escape(number(state.trace[i], 5)) : '—'}</output></button>`).join('')}</div><p class="inspector-note">Registers are evaluated by the C++ IR interpreter. Change the input intensity to inspect another channel. Select any row to reveal its value and source.</p>`;
  $('trace-reset').addEventListener('click', () => { state.step = -1; irView(); });
  $('trace-step').addEventListener('click', () => {
    state.step = Math.min(ir.length - 1, state.step + 1); irView();
    const focusTarget = $('trace-step').disabled ? document.querySelector('.trace-row.current') : $('trace-step');
    focusTarget?.focus({ preventScroll: true });
    document.querySelector('.trace-row.current')?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  });
  document.querySelectorAll('[data-instruction]').forEach(button => button.addEventListener('click', () => {
    if (!current()) return status('Compile the edited source before tracing.');
    state.step = Number(button.dataset.instruction);
    sourceLocation(Number(button.dataset.start), Number(button.dataset.end)); irView();
  }));
}
function codeMarkup(text, mapping = []) {
  const map = new Map();
  mapping.forEach(inst => { map.set(inst.line, inst); if (inst.op === 'clamp') map.set(inst.line + 1, inst); });
  return `<div class="code-view" aria-label="Generated code">${text.split('\n').map((line, index) => {
    const inst = map.get(index + 1), contents = `<span class="line-number" aria-hidden="true">${index + 1}</span><span>${escape(line) || ' '}</span>`;
    return inst ? `<button class="code-row" data-start="${inst.start}" data-end="${inst.end}" aria-label="Line ${index + 1}: ${escape(line.trim())}. Locate source.">${contents}</button>` : `<div class="code-row ${line.trim().startsWith('//') ? 'is-comment' : ''}">${contents}</div>`;
  }).join('')}</div>`;
}
function ptxView() {
  const c = state.compilation;
  $('inspector-body').innerHTML = `<div class="view-toolbar">${toggleMarkup()}<button id="copy-ptx" class="button quiet" ${current() ? '' : 'disabled'}>Copy PTX</button></div>${codeMarkup(state.before ? c.beforePtx : c.ptx, state.before ? c.beforeIr : c.ir)}<p class="inspector-note">One thread processes one float channel: index = blockIdx.x × blockDim.x + threadIdx.x. RGB pixels occupy three adjacent channels. Highlighted instructions link to source expressions.</p>`;
  wireVersions(); wireMappings($('inspector-body'));
  $('copy-ptx').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.before ? c.beforePtx : c.ptx); status('PTX copied.'); }
    catch { status('Clipboard is unavailable. Use Export PTX to save the kernel.', 'error'); }
  });
}
function binaryView() {
  const binary = state.binary;
  if (binary) {
    $('inspector-body').innerHTML = `<div class="view-toolbar"><span class="badge">PTXAS accepted · ${binary.bytes.toLocaleString('en-US')} byte CUBIN</span><div class="binary-actions"><button id="save-cubin" class="button outline">Export CUBIN</button><button id="assemble" class="button quiet">Assemble again</button></div></div><pre class="binary-log">${escape(binary.log || 'Assembly succeeded.')}</pre>${binary.sass ? codeMarkup(binary.sass) : '<p class="inspector-note">SASS inspection requires nvdisasm. The CUBIN was assembled successfully.</p>'}${binary.sass?.includes('FADD.SAT') ? '<p class="inspector-note"><strong>Backend optimization:</strong> this binary uses FADD.SAT, combining the add and 0–1 clamp into one machine instruction.</p>' : ''}<p class="inspector-note">Offline compilation for ${binary.target}. This binary has not been executed on an NVIDIA GPU.</p>`;
    $('save-cubin').disabled = !current();
    $('save-cubin').addEventListener('click', () => {
      if (!current()) return;
      download(Uint8Array.from(atob(binary.cubin), c => c.charCodeAt(0)), 'filter.sm_75.cubin', 'application/octet-stream');
    });
  } else {
    const available = state.health?.ptxas;
    $('inspector-body').innerHTML = `<div class="binary-placeholder"><h3>${available ? 'NVIDIA’s assembler is ready.' : 'PTX is ready. NVIDIA’s assembler is optional.'}</h3><p>${available ? 'Compile your emitted PTX into a real sm_75 CUBIN and inspect NVIDIA machine instructions. This stage runs on your CPU and does not need a local NVIDIA GPU.' : 'The parser, optimizer, image preview, and PTX generator work now. To add offline CUBIN and SASS inspection, put ptxas and nvdisasm on PATH, set CUDA_PATH, or use the project’s .tools/cuda/bin directory.'}</p><code>ptxas -arch=sm_75 -v filter.ptx -o filter.cubin</code><div class="binary-actions"><button id="assemble" class="button primary" ${!available || !current() ? 'disabled' : ''}>Assemble PTX</button><button id="refresh-tools" class="button outline">Check for tools</button></div><p>The GPU panel loads generated PTX through the CUDA Driver API. Separate-module device linking remains future work.</p></div>`;
    $('refresh-tools').addEventListener('click', async () => { await loadHealth(); binaryView(); });
  }
  $('assemble')?.addEventListener('click', assemble);
}
async function assemble() {
  if (!current()) return;
  const revision = state.revision;
  const button = $('assemble'); button.disabled = true; button.textContent = 'Assembling…'; status('Running NVIDIA PTXAS offline…');
  try {
    const result = await api('assemble', { source: state.compilation.source });
    if (revision !== state.revision || !current()) return;
    state.binary = result;
    if (state.stage === 'binary') binaryView();
    status('PTXAS assembled a real NVIDIA CUBIN. Use the separate GPU panel to execute generated PTX.');
  } catch (error) {
    if (revision !== state.revision) return;
    status(`Assembly failed: ${error.message}`, 'error');
    if (state.stage === 'binary') { binaryView(); const p = document.createElement('p'); p.className = 'diagnostic'; p.textContent = error.message; $('inspector-body').append(p); }
  }
}
function renderStage() {
  document.querySelectorAll('[data-stage]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.stage === state.stage)));
  $('inspector-heading').textContent = stages[state.stage][0]; $('inspector-subtitle').textContent = stages[state.stage][1];
  if (!state.compilation) { $('inspector-body').innerHTML = '<p class="empty-state">Compile a valid filter to inspect this stage.</p>'; return; }
  ({ optimizer: compareView, ast: treeView, ir: irView, ptx: ptxView, binary: binaryView })[state.stage]();
}
function drawCurve() {
  const canvas = $('curve'), ctx = canvas.getContext('2d'), { width: w, height: h } = canvas;
  const color = name => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
  ctx.clearRect(0, 0, w, h);
  const x0 = 38, y0 = h - 30, cw = w - 55, ch = h - 50;
  ctx.strokeStyle = color('border'); ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const x = x0 + cw * i / 4, y = y0 - ch * i / 4; ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, y0); ctx.moveTo(x0, y); ctx.lineTo(w - 12, y); ctx.stroke(); }
  ctx.font = '17px Segoe UI'; ctx.fillStyle = color('muted'); ctx.fillText('0', 9, y0 + 5); ctx.fillText('1', 9, 19); ctx.fillText('0', x0 - 5, h - 5); ctx.fillText('1', w - 20, h - 5);
  ctx.setLineDash([5, 5]); ctx.strokeStyle = color('scrollbar'); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + cw, y0 - ch); ctx.stroke(); ctx.setLineDash([]);
  const curve = state.compilation?.curve;
  if (!curve) return;
  ctx.strokeStyle = color('primary'); ctx.lineWidth = 4; ctx.beginPath(); let drawing = false;
  curve.forEach((value, i) => {
    if (value === null) { drawing = false; return; }
    const x = x0 + cw * i / 100, y = y0 - ch * Math.max(0, Math.min(1, value));
    if (drawing) ctx.lineTo(x, y); else ctx.moveTo(x, y); drawing = true;
  }); ctx.stroke();
  if (state.trace) {
    const result = state.trace.at(-1);
    if (result !== null) { const x = x0 + state.pixel * cw, y = y0 - ch * Math.max(0, Math.min(1, result)); ctx.fillStyle = color('primary'); ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); }
  }
}
async function updateTrace() {
  if (!current()) return;
  const revision = state.revision, token = ++state.traceToken, value = state.pixel;
  try {
    const result = await api('trace', { source: state.compilation.source, pixel: value });
    if (revision !== state.revision || token !== state.traceToken || value !== state.pixel) return;
    state.trace = result.trace; state.step = -1;
    $('probe-out').textContent = number(result.values[0]); drawCurve();
    if (state.stage === 'ir') irView();
  } catch (error) { if (revision === state.revision && token === state.traceToken) status(`Trace unavailable: ${error.message}`, 'error'); }
}
function drawInput() {
  const canvas = $('input-image'); canvas.width = state.input.width; canvas.height = state.input.height;
  canvas.getContext('2d').putImageData(state.input, 0, 0);
  canvas.setAttribute('aria-label', `Original image: ${state.imageName}`);
  $('output-image').width = canvas.width; $('output-image').height = canvas.height;
  $('image-name').textContent = state.imageName;
  $('image-dimensions').textContent = `${canvas.width} × ${canvas.height}`;
}
async function renderImage() {
  if (!current() || !state.input) return;
  const revision = state.revision, imageRevision = state.imageRevision, token = ++state.renderToken;
  const original = state.input;
  state.output = null; updateActions();
  $('image-overlay').textContent = 'Running C++ IR…'; $('image-overlay').hidden = false;
  $('preview-state').textContent = 'Rendering on CPU';
  const pixels = [];
  for (let i = 0; i < original.data.length; i += 4) pixels.push(original.data[i] / 255, original.data[i + 1] / 255, original.data[i + 2] / 255);
  try {
    const result = await api('run', { source: state.compilation.source, pixels });
    if (revision !== state.revision || imageRevision !== state.imageRevision || token !== state.renderToken || !current()) return;
    const output = new ImageData(original.width, original.height);
    for (let i = 0, channel = 0; i < output.data.length; i += 4) {
      for (let c = 0; c < 3; c++) { const value = result.values[channel++]; output.data[i + c] = value === null ? 0 : Math.max(0, Math.min(1, value)) * 255; }
      output.data[i + 3] = original.data[i + 3];
    }
    state.output = output;
    $('output-image').getContext('2d').putImageData(output, 0, 0);
    $('image-overlay').hidden = true;
    $('preview-state').textContent = 'CPU result · current'; $('preview-state').classList.remove('stale');
    $('verification').textContent = `${result.checked.toLocaleString('en-US')} channels checked · ${result.mismatches} AST/IR mismatches${result.nonFinite ? ` · ${result.nonFinite} nonfinite (shown black)` : ''}`;
    $('render-timing').textContent = `${result.processMs.toFixed(0)} ms CPU process + IPC`;
    status('Compiled and rendered. Select a stage to explore the pipeline.'); updateActions();
  } catch (error) {
    if (revision !== state.revision || token !== state.renderToken) return;
    $('image-overlay').textContent = 'Render failed · compile to retry'; $('preview-state').textContent = 'Render failed';
    $('verification').textContent = 'Reference comparison unavailable'; status(error.message, 'error'); updateActions();
  }
}
async function compile() {
  const text = source.value, revision = state.revision, token = ++state.compileToken;
  compileController?.abort(); compileController = new AbortController(); state.busy = true; updateActions();
  $('diagnostic').textContent = ''; source.removeAttribute('aria-invalid'); status('Compiling with the C++ front end…');
  try {
    const c = await api('compile', { source: text }, compileController.signal);
    if (revision !== state.revision || token !== state.compileToken) return;
    state.compilation = c; state.dirty = false; state.trace = null; state.binary = null; state.step = -1;
    renderStage(); drawCurve(); updateActions();
    status(`C++ compilation complete (${c.compileMs.toFixed(1)} ms process + IPC). Rendering…`);
    await Promise.all([updateTrace(), renderImage()]);
  } catch (error) {
    if (revision !== state.revision || token !== state.compileToken || error.name === 'AbortError') return;
    state.dirty = true;
    const start = error.start ?? 0, line = text.slice(0, start).split('\n').length, column = start - text.lastIndexOf('\n', start - 1);
    $('diagnostic').textContent = `${error.start === undefined ? '' : `Line ${line}, column ${column}: `}${error.message}`;
    source.setAttribute('aria-invalid', 'true'); source.focus({ preventScroll: true }); source.setSelectionRange(start, error.end ?? start);
    $('preview-state').textContent = 'Compilation failed'; $('preview-state').classList.add('stale');
    $('image-overlay').textContent = 'Previous output · compilation failed'; $('image-overlay').hidden = false;
    status('Compilation failed. Correct the source and compile again.', 'error');
    renderStage();
  } finally {
    if (token === state.compileToken) { state.busy = false; updateActions(); }
  }
}

// A deterministic ray-traced color target: no network image or assets needed.
function proceduralImage() {
  const width = 352, height = 220, image = new ImageData(width, height);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const norm = a => { const n = Math.sqrt(dot(a, a)); return a.map(v => v / n); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const camera = [0, 2.7, 6.3], forward = norm(sub([0, .7, 0], camera)), right = norm(cross(forward, [0, 1, 0])), up = cross(right, forward);
  const light = norm([-3, 6, 4]);
  const spheres = [
    { center: [-1.12, .87, .05], radius: .87, color: [.94, .22, .065] },
    { center: [.6, .65, .8], radius: .65, color: [.035, .55, .67] },
    { center: [1.38, .48, -.7], radius: .48, color: [.49, .27, .71] },
    { center: [.05, .3, -1.2], radius: .3, color: [.95, .72, .075] }
  ];
  function sphereHit(origin, direction, sphere) {
    const oc = sub(origin, sphere.center), b = dot(oc, direction), c = dot(oc, oc) - sphere.radius ** 2, disc = b * b - c;
    if (disc < 0) return Infinity;
    const t = -b - Math.sqrt(disc); return t > .001 ? t : Infinity;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = (2 * (x + .5) / width - 1) * width / height * .5, sy = (1 - 2 * (y + .5) / height) * .5;
    const ray = norm(forward.map((v, i) => v + sx * right[i] + sy * up[i]));
    let t = ray[1] < 0 ? -camera[1] / ray[1] : Infinity, hit = null;
    for (const sphere of spheres) { const st = sphereHit(camera, ray, sphere); if (st < t) { t = st; hit = sphere; } }
    let color;
    if (Number.isFinite(t)) {
      const point = camera.map((v, i) => v + ray[i] * t);
      const normal = hit ? norm(sub(point, hit.center)) : [0, 1, 0];
      const checker = (Math.floor(point[0] * 1.05) + Math.floor(point[2] * 1.05)) % 2 === 0;
      const base = hit ? hit.color : (checker ? [.73, .78, .77] : [.88, .87, .8]);
      const shadowOrigin = point.map((v, i) => v + normal[i] * .002);
      const shadow = spheres.some(sphere => Number.isFinite(sphereHit(shadowOrigin, light, sphere)));
      const lambert = Math.max(0, dot(normal, light)) * (shadow ? .1 : .78) + .22;
      const half = norm(light.map((v, i) => v - ray[i]));
      const spec = hit && !shadow ? Math.max(0, dot(normal, half)) ** 70 * .65 : 0;
      color = base.map(v => v * lambert + spec);
      if (!hit) { const fog = Math.min(.68, Math.max(0, t - 6) * .045); color = color.map((v, i) => v * (1 - fog) + [.64, .77, .79][i] * fog); }
    } else color = [.63, .76, .79];
    const index = (y * width + x) * 4;
    color.forEach((value, c) => image.data[index + c] = Math.min(1, Math.max(0, value)) ** (1 / 2.2) * 255);
    image.data[index + 3] = 255;
  }
  return image;
}
async function loadHealth() {
  try {
    const response = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Local compiler service is unavailable.');
    state.health = await response.json();
    if (!state.health.compiler) status('Build the C++ compiler with npm run build, then restart the server.', 'error');
  } catch (error) { status(`Service unavailable: ${error.message}. Run npm start.`, 'error'); }
}
source.addEventListener('input', () => { document.querySelectorAll('[data-preset]').forEach(b => b.setAttribute('aria-pressed', 'false')); markDirty(); });
source.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!state.busy) compile(); }
});
$('compile').addEventListener('click', compile);
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
  source.value = presets[button.dataset.preset]; markDirty();
  document.querySelectorAll('[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); compile();
}));
document.querySelectorAll('[data-stage]').forEach(button => button.addEventListener('click', () => { state.stage = button.dataset.stage; renderStage(); }));
$('pixel').addEventListener('input', () => {
  state.pixel = Number($('pixel').value); state.trace = null; state.step = -1;
  $('pixel-value').value = number(state.pixel); $('probe-in').textContent = number(state.pixel); $('probe-out').textContent = '…';
  drawCurve(); clearTimeout(traceTimer); traceTimer = setTimeout(updateTrace, 100);
  if (state.stage === 'ir' && state.compilation) irView();
});
$('export-ptx').addEventListener('click', () => {
  if (!current()) return;
  download(state.before && state.stage === 'ptx' ? state.compilation.beforePtx : state.compilation.ptx, 'filter.ptx'); status('Generated PTX exported.');
});
$('save-image').addEventListener('click', () => {
  if (!current() || !state.output) return;
  $('output-image').toBlob(blob => { if (blob) { download(blob, 'pixelptx-output.png'); status('Output image exported.'); } });
});
$('upload').addEventListener('click', () => $('image-file').click());
$('image-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) { status('Choose a PNG, JPEG, or WebP image smaller than 8 MB.', 'error'); event.target.value = ''; return; }
  const imageRevision = ++state.imageRevision;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (imageRevision !== state.imageRevision) return;
    const scale = Math.min(1, 352 / bitmap.width, 256 / bitmap.height);
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    state.input = ctx.getImageData(0, 0, canvas.width, canvas.height); state.output = null; state.imageName = file.name;
    drawInput(); $('reset-image').hidden = false; updateActions();
    if (current()) await renderImage(); else { $('image-overlay').textContent = 'Compile to render this image'; $('image-overlay').hidden = false; }
  } catch { status('This image could not be decoded. Try another PNG, JPEG, or WebP.', 'error'); }
  finally { bitmap?.close(); event.target.value = ''; }
});
$('reset-image').addEventListener('click', () => {
  state.imageRevision++; state.input = proceduralImage(); state.output = null; state.imageName = 'Procedural color study · synthetic'; drawInput(); $('reset-image').hidden = true; updateActions(); if (current()) renderImage();
});
$('presentation').addEventListener('click', () => {
  const enabled = document.body.classList.toggle('presenting'); $('presentation').setAttribute('aria-pressed', String(enabled)); $('presentation').textContent = enabled ? 'Exit presentation' : 'Present';
  status(enabled ? 'Presentation layout enabled. Walk through the numbered compilation stages.' : 'Standard workbench layout restored.');
});
try { const saved = localStorage.getItem('pixelptx.source'); if (saved !== null && saved.length <= 8192) { source.value = saved; document.querySelectorAll('[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(presets[b.dataset.preset] === saved))); } } catch { /* Storage may be disabled. */ }
gpuControls = initGpu({ snapshot: () => ({ source: state.compilation?.source, input: state.input }), isCurrent: current });
state.input = proceduralImage(); drawInput(); drawCurve(); updateActions();
await loadHealth();
await compile();
