import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const candidates = [
  process.env.FOTOVIBE_PYTHON,
  process.platform === 'win32' ? resolve(root, '.venv/Scripts/python.exe') : resolve(root, '.venv/bin/python'),
  process.platform === 'win32' ? 'python.exe' : 'python3',
  'python',
].filter(Boolean);

function usable(command) {
  if (command.includes('/') || command.includes('\\')) return existsSync(command);
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

const python = candidates.find(usable);
if (!python) {
  console.error('Kein Python gefunden. Zuerst npm run setup:tests ausführen.');
  process.exit(1);
}

const port = process.env.PORT || '8080';
const server = spawn(
  python,
  [
    '-m',
    'uvicorn',
    'fotovibe.app:create_app',
    '--factory',
    '--host',
    '127.0.0.1',
    '--port',
    port,
    '--no-access-log',
  ],
  {
    cwd: root,
    env: { ...process.env, FOTOVIBE_DEV: '1' },
    stdio: 'inherit',
  },
);

let shuttingDown = false;
function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill(signal);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
server.on('exit', (code, signal) => {
  if (signal && !shuttingDown) process.exit(1);
  process.exit(code ?? 0);
});
