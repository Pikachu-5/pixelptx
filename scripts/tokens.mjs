import { readFileSync, writeFileSync } from 'node:fs';
const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');
let section = '', family = '', declarations = [];
for (const line of design.split('\n').slice(1)) {
  if (line === '---') break;
  if (/^[a-z]+:/.test(line)) section = line.split(':')[0];
  const token = line.match(/^  ([\w-]+): "([^"]+)"/);
  if (token && ['colors', 'rounded', 'spacing'].includes(section)) declarations.push(`  --${{ colors: 'color', rounded: 'radius', spacing: 'space' }[section]}-${token[1]}: ${token[2]};`);
  if (section === 'typography') {
    const role = line.match(/^  (\w+):$/); if (role) family = role[1];
    const font = line.match(/^    fontFamily: "([^"]+)"/);
    if (font) declarations.push(`  --font-${family}: ${font[1]};`);
  }
}
const css = `/* Generated from DESIGN.md by scripts/tokens.mjs. */\n:root {\n${declarations.join('\n')}\n}\n`;
const file = new URL('../web/tokens.css', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(file, 'utf8') !== css) throw new Error('Design tokens drifted. Run node scripts/tokens.mjs.');
} else writeFileSync(file, css);
