import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error(`${command} could not start. Install CMake and a C++20 compiler. ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status || 1);
}
const configure = ['-S', '.', '-B', 'build', '-DCMAKE_BUILD_TYPE=Release'];
if (!existsSync(path.join(root, 'build', 'CMakeCache.txt')) && spawnSync('ninja', ['--version'], { windowsHide: true }).status === 0) configure.push('-G', 'Ninja');
run('cmake', configure);
run('cmake', ['--build', 'build', '--config', 'Release']);
