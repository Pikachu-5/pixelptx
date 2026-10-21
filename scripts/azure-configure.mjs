import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(2), index = args.indexOf('--subscription');
const subscriptionId = index >= 0 ? args[index + 1] : null;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId || '')) {
  console.error('Usage: npm run azure:configure -- --subscription <Azure subscription UUID>'); process.exitCode = 1;
} else {
  await writeFile(new URL('../azure.local.json', import.meta.url), JSON.stringify({ enabled: true, subscriptionId,
    location: 'centralindia', vmSize: 'Standard_NC4as_T4_v3' }, null, 2));
  console.log('Azure configured locally. Restart PixelPTX. Only an explicit GPU run creates compute.');
}
