import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('static/vendor', { recursive: true });
await copyFile('node_modules/heic-to/dist/csp/heic-to.js', 'static/vendor/heic-to.js');
await copyFile('node_modules/heic-to/LICENSE', 'static/vendor/HEIC-LICENSE');

