const $ = id => document.getElementById(id);
const finished = state => ['succeeded', 'failed', 'cancelled', 'cleanup-failed'].includes(state);
const labels = { preparing: 'Preparing', starting: 'Starting', allocating: 'Waiting for T4', building: 'Building runner', running: 'Running PTX', collecting: 'Collecting', deleting: 'Deleting compute', cancelling: 'Cancelling', succeeded: 'GPU off · verified', failed: 'GPU off · run failed', cancelled: 'GPU off · cancelled', 'cleanup-failed': 'Cleanup needs attention' };

export function initGpu({ snapshot, isCurrent }) {
  let config, run, busy = false, uncertain = false, timer, captured, renderedId, lastMessage, statusRevision = 0;
  async function request(url, body) {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'X-PixelPTX-Cloud': 'explicit-run' } : {},
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'GPU service unavailable.');
    return data;
  }
  function message(text, error = false) {
    if (text !== lastMessage) { $('gpu-status').textContent = text; lastMessage = text; }
    $('gpu-status').dataset.tone = error ? 'error' : 'info';
  }
  function refresh() {
    const active = run && !finished(run.state);
    $('gpu-run').disabled = busy || uncertain || active || run?.state === 'cleanup-failed' || !config?.available || !isCurrent() || !$('gpu-consent').checked;
    $('gpu-run').setAttribute('aria-busy', String(busy || Boolean(active)));
    $('gpu-consent').disabled = busy || Boolean(active);
    $('gpu-cancel').hidden = !active; $('gpu-cancel').disabled = busy || ['deleting', 'cancelling'].includes(run?.state);
    $('gpu-retry-cleanup').hidden = run?.state !== 'cleanup-failed'; $('gpu-retry-cleanup').disabled = busy;
    $('gpu-badge').textContent = run ? labels[run.state] || run.state : 'GPU off';
    if (captured?.runId === run?.id && run?.result) $('gpu-caption').textContent = captured.input === snapshot().input && run.source === snapshot().source && isCurrent() ? 'Current image · generated PTX on GPU' : 'Previous run · image or source changed';
  }
  function render() {
    refresh(); if (!run) return;
    message(run.message, run.state === 'failed' || run.state === 'cleanup-failed');
    $('gpu-progress').hidden = false;
    $('gpu-progress').replaceChildren(...run.events.filter((event, index) => event.state !== run.events[index + 1]?.state).map(event => {
      const item = document.createElement('li'); item.textContent = labels[event.state] || event.state;
      if (event === run.events.at(-1)) item.setAttribute('aria-current', 'step'); return item;
    }));
    const result = run.result;
    if (!result || renderedId === run.id) return;
    renderedId = run.id; $('gpu-result').hidden = false;
    const canvas = $('gpu-image'); canvas.width = run.width; canvas.height = run.height;
    const output = new ImageData(run.width, run.height);
    for (let i = 0, j = 0; i < output.data.length; i += 4) {
      for (let c = 0; c < 3; c++) { const value = result.values[j++]; output.data[i + c] = value === null ? 0 : Math.max(0, Math.min(1, value)) * 255; }
      output.data[i + 3] = captured?.runId === run.id ? captured.input.data[i + 3] : 255;
    }
    canvas.getContext('2d').putImageData(output, 0, 0);
    $('gpu-caption').textContent = captured?.runId === run.id ? 'Captured image · generated PTX on GPU' : 'Saved run · original image not matched';
    $('gpu-save').disabled = false;
    const count = result.original.checked + result.optimized.checked + result.selfTest.checked;
    const mismatches = result.original.mismatches + result.optimized.mismatches + result.selfTest.mismatches;
    $('gpu-summary').textContent = `${result.device} · ${count.toLocaleString('en-US')} channel comparisons · ${mismatches} mismatches. Original and optimized PTX were both executed.`;
    const metrics = [
      ['Kernel · original', `${result.original.kernelMs.toFixed(4)} ms`], ['Kernel · optimized', `${result.optimized.kernelMs.toFixed(4)} ms`],
      ['JIT · optimized', `${result.optimized.jitMs.toFixed(2)} ms`], ['Physical registers / thread', `${result.original.registers} → ${result.optimized.registers}`],
      ['Bounds guard errors', String(result.original.guardErrors + result.optimized.guardErrors + result.selfTest.guardErrors)],
      ['Hardware test suite', `${result.selfTest.expressions} expressions / ${result.selfTest.launches} launches`]
    ];
    $('gpu-metrics').replaceChildren(...metrics.flatMap(([label, value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; return [dt, dd]; }));
    const { values, ...evidence } = result;
    $('gpu-evidence').textContent = JSON.stringify({ runId: run.id, source: run.source, ptxSha256: run.ptxSha256, ...evidence }, null, 2);
    refresh();
  }
  async function poll() {
    clearTimeout(timer);
    if (!run) return;
    const id = run.id, revision = ++statusRevision;
    try {
      const next = await request(`/api/gpu/runs/${id}`);
      if (revision !== statusRevision || run?.id !== id) return;
      run = next; uncertain = false; render();
    } catch (error) { message(`Status unavailable: ${error.message} The server may still be running and deleting compute. Use Check status to reconnect.`, true); }
    if (run && !finished(run.state)) timer = setTimeout(poll, 5000);
  }
  async function reconnect() {
    const revision = ++statusRevision;
    try {
      const next = await request('/api/gpu/config');
      if (revision !== statusRevision) return;
      config = next;
      if (config.latest) {
        const latest = await request(`/api/gpu/runs/${config.latest}`);
        if (revision !== statusRevision) return;
        run = latest; uncertain = false; render(); if (!finished(run.state)) timer = setTimeout(poll, 1000);
      }
      else {
        uncertain = false;
        message(config.available ? 'GPU off. Compile a filter, acknowledge the charge, then start a run.' : config.error || 'Azure is not configured. Run npm run azure:configure -- --subscription <id> and restart PixelPTX.');
      }
      refresh();
    } catch (error) { message(`Cannot check GPU status: ${error.message}`, true); }
  }
  $('gpu-consent').addEventListener('change', refresh);
  $('gpu-run').addEventListener('click', async () => {
    if ($('gpu-run').disabled) return;
    const input = snapshot(); if (!input.input || !isCurrent()) return;
    const rgb = new Uint8Array(input.input.width * input.input.height * 3);
    for (let i = 0, j = 0; i < input.input.data.length; i += 4) for (let c = 0; c < 3; c++) rgb[j++] = input.input.data[i + c];
    let binary = ''; for (let i = 0; i < rgb.length; i += 8192) binary += String.fromCharCode(...rgb.subarray(i, i + 8192));
    const requestId = crypto.randomUUID();
    statusRevision++; clearTimeout(timer);
    busy = true; refresh(); message('Submitting a temporary GPU run…');
    captured = { input: input.input, runId: null };
    try {
      run = await request('/api/gpu/runs', { source: input.source, width: input.input.width, height: input.input.height, rgb: btoa(binary), requestId, consent: true });
      captured.runId = run.id; renderedId = null; $('gpu-result').hidden = true; $('gpu-save').disabled = true;
      $('gpu-consent').checked = false; render(); timer = setTimeout(poll, 1000);
    } catch (error) {
      // A dropped response may still have created the run. Reconcile before another submission.
      uncertain = true; message(`Run submission needs a status check: ${error.message}`, true); await reconnect();
    } finally { busy = false; refresh(); }
  });
  $('gpu-cancel').addEventListener('click', async () => {
    if (!run || busy) return; busy = true; refresh();
    statusRevision++;
    try { run = await request(`/api/gpu/runs/${run.id}/cancel`, {}); render(); }
    catch (error) { message(`Cancellation not confirmed: ${error.message}. Check status.`, true); }
    finally { busy = false; refresh(); timer = setTimeout(poll, 1000); }
  });
  $('gpu-retry-cleanup').addEventListener('click', async () => {
    busy = true; refresh();
    try { run = await request(`/api/gpu/runs/${run.id}/cleanup`, {}); render(); timer = setTimeout(poll, 1000); }
    catch (error) { message(error.message, true); }
    finally { busy = false; refresh(); }
  });
  $('gpu-refresh').addEventListener('click', reconnect);
  $('gpu-save').addEventListener('click', () => $('gpu-image').toBlob(blob => {
    if (!blob) return; const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'pixelptx-gpu-output.png'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));
  void reconnect();
  return { refresh };
}
