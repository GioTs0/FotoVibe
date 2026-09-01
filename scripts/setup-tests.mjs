import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: options.env || process.env,
  });
  if (result.error) {
    if (options.allowMissing && result.error.code === 'ENOENT') return null;
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function commandExists(command) {
  const result = run(command, ['--version'], { capture: true, allowMissing: true, allowFailure: true });
  return Boolean(result && result.status === 0);
}

function reportNativeTools() {
  const os = platform();
  if (os === 'darwin') {
    const xcode = run('xcode-select', ['-p'], { capture: true, allowMissing: true, allowFailure: true });
    const runtimes = run('xcrun', ['simctl', 'list', 'runtimes'], {
      capture: true,
      allowMissing: true,
      allowFailure: true,
    });
    const output = runtimes?.stdout || '';
    if (xcode?.status === 0 && /iOS|tvOS/.test(output)) {
      console.log('✓ Xcode-Simulator erkannt (iOS/tvOS-Runtime verfügbar).');
    } else {
      console.log(
        'ℹ Xcode-Simulator nicht vollständig erkannt. Für iPhone/iPad/tvOS Xcode aus dem Mac App Store installieren und mindestens eine Runtime nachladen.',
      );
    }
  }

  const home = homedir();
  const sdkRoot =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (os === 'win32'
      ? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Android', 'Sdk')
      : os === 'darwin'
        ? join(home, 'Library', 'Android', 'sdk')
        : join(home, 'Android', 'Sdk'));
  const executable = os === 'win32' ? 'emulator.exe' : 'emulator';
  const adbExecutable = os === 'win32' ? 'adb.exe' : 'adb';
  const emulator = join(sdkRoot, 'emulator', executable);
  const adb = join(sdkRoot, 'platform-tools', adbExecutable);
  if (existsSync(emulator) && existsSync(adb)) {
    const avds = run(emulator, ['-list-avds'], { capture: true, allowFailure: true });
    const names = (avds?.stdout || '').split(/\r?\n/).filter(Boolean);
    console.log(`✓ Android-Emulator erkannt (${names.length} AVD(s) vorhanden).`);
    if (!names.length) {
      console.log('  Noch kein AVD angelegt; in Android Studio ein Pixel- und ein Android-TV/Google-TV-Gerät erstellen.');
    }
  } else {
    console.log(
      'ℹ Android-Emulator nicht erkannt. Android Studio inklusive SDK/Emulator separat installieren; das Setup kann die großen System-Images nicht als npm-Dependency bündeln.',
    );
  }
}

console.log('Installiere reproduzierbare FotoVibe-Testumgebung …');

if (!commandExists('uv')) {
  console.error('uv wurde nicht gefunden. Einmalig uv installieren: https://docs.astral.sh/uv/getting-started/installation/');
  process.exit(1);
}

const cleanEnv = { ...process.env };
delete cleanEnv.UV_DEFAULT_INDEX;
run('uv', ['sync', '--frozen'], { env: cleanEnv });
run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
run(npm, ['run', 'build']);

console.log('Installiere Playwright-Browser (Chromium, Firefox und WebKit) …');
run(npx, ['playwright', 'install', 'chromium', 'firefox', 'webkit']);
reportNativeTools();

console.log('\nTestumgebung bereit. Starten mit: npm run test:e2e');
console.log('Für die interaktive Playwright-Oberfläche: npm run test:e2e:ui');
