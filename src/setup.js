import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (!existsSync('.env')) {
  const content = readFileSync('.env.example', 'utf8')
    .replace(/^API_TOKEN=$/m, `API_TOKEN=${randomBytes(32).toString('hex')}`)
    .replace(/^DATA_KEY=$/m, `DATA_KEY=${randomBytes(32).toString('hex')}`);
  writeFileSync('.env', content, { flag: 'wx', mode: 0o600 });
  console.log('.env creado con claves locales. No lo compartas.');
} else console.log('.env ya existe, se conserva.');
if (!existsSync('config.local.json')) writeFileSync('config.local.json', readFileSync('config.example.json'), { flag: 'wx', mode: 0o600 });
console.log('Siguiente paso: npm run connect. Para comprobar sin WhatsApp: npm run demo.');
