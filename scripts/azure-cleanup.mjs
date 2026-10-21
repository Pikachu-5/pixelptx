import { GpuRuns, loadConfig } from './azure.mjs';
const config = await loadConfig();
if (!config) throw new Error('Configure the original Azure subscription before recovery cleanup.');
const gpu = new GpuRuns({ config });
try {
  const info = await gpu.info();
  if (info.error) throw new Error(info.error);
  const unresolved = [...gpu.runs.values()].filter(run => !run.cleanupConfirmed);
  if (unresolved.length) throw new Error(`Cleanup is not confirmed for: ${unresolved.map(run => run.group).join(', ')}`);
  console.log('All recorded temporary Azure runs have confirmed cleanup. No compute was started.');
} finally { await gpu.close(); }
