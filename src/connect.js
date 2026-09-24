import { configuration, routing } from './config.js';
import { whatsapp } from './whatsapp.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync, writeFileSync, openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { listGroups } from './groups.js';
const config = configuration(), routes = routing();
mkdirSync(config.directory, { recursive: true, mode: 0o700 });
const lock = join(config.directory, 'worker.lock');
if (existsSync(lock)) throw new Error('Detén npm start antes de vincular WhatsApp.');
const descriptor = openSync(lock, 'wx', 0o600);
writeFileSync(descriptor, String(process.pid));
const terminal = createInterface({ input: stdin, output: stdout });
let sender;
try {
  sender = await whatsapp({ ...config, mode: 'web' });
  const deadline = Date.now() + 5 * 60000;
  while (!sender.ready && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
  if (!sender.ready) throw new Error('No se completó la vinculación en 5 minutos. Vuelve a ejecutar npm run connect.');
  console.log('Cargando grupos; la primera sincronización puede tardar unos segundos...');
  const groups = await listGroups(sender.client);
  groups.forEach((g, i) => console.log(`${i + 1}. ${g.name} (${g.id._serialized})`));
  if (!groups.length) throw new Error('Añade este número al grupo Control Teleconsultas VIP y vuelve a ejecutar el comando.');
  const index = Number(await terminal.question('Número del grupo Control Teleconsultas VIP: ')) - 1;
  if (!Number.isInteger(index) || !groups[index]) throw new Error('Selección inválida');
  routes.controlGroupId = groups[index].id._serialized;
  // Preserve the group even if the optional doctor setup fails later.
  writeFileSync('config.local.json', JSON.stringify(routes, null, 2) + '\n', { mode: 0o600 });
  const phone = (await terminal.question('WhatsApp de un médico (ej. 573001234567). Enter para configurarlo después: ')).trim();
  if (phone) {
    if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error('Usa código de país y número sin + ni espacios');
    if (!await sender.client.getNumberId(phone)) throw new Error('Número no disponible en WhatsApp');
    const id = (await terminal.question('Identificador exacto de este médico en MediConecta: ')).trim();
    if (!/^[\w-]{1,100}$/.test(id) || id === 'PROVIDER_UNAVAILABLE') throw new Error('Identificador inválido');
    routes.doctors[id] = phone;
  }
  writeFileSync('config.local.json', JSON.stringify(routes, null, 2) + '\n', { mode: 0o600 });
  console.log('Sesión y destinatarios guardados. No se enviaron mensajes.');
  console.log('Configura la fuente de citas, cambia WHATSAPP_MODE=web en .env y ejecuta npm start.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'No se pudo completar la configuración. La sesión vinculada se conserva.');
  process.exitCode = 1;
} finally {
  terminal.close(); await sender?.close().catch(() => {}); closeSync(descriptor); unlinkSync(lock);
}
