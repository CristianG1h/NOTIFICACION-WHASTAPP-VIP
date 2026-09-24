import { configuration, routing } from './config.js';
import { Store } from './store.js';
import { whatsapp } from './whatsapp.js';
import { vipBridge } from './bridge.js';
import { server } from './server.js';
import { vipApiSource } from './vip-api.js';
import { openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const config = configuration();
const routes = routing('config.local.json', process.env);
const store = new Store(config, routes);

// Local execution keeps a lock to prevent double sends. On Render with a persistent
// disk there is only one service instance attached to that disk, and a lock file
// surviving a crash/redeploy would block the next boot, so Render doesn't persist it.
const useLock = !process.env.RENDER;
const lock = join(config.directory, 'worker.lock');
let descriptor;
if (useLock) {
  try {
    descriptor = openSync(lock, 'wx', 0o600);
    writeFileSync(descriptor, String(process.pid));
  } catch (error) {
    store.close();
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Existe un bloqueo anterior. Si ya cerraste el bot, ejecuta npm run unlock.');
  }
}

let bridge, sender, app, timer, running = false, stopping = false;
const health = { sourceHealthy: true };
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (app?.listening) await new Promise(resolve => app.close(resolve));
  while (running) await new Promise(resolve => setTimeout(resolve, 50));
  await sender?.close().catch(() => {});
  bridge?.close();
  store.close();
  if (descriptor !== undefined) {
    closeSync(descriptor);
    try { unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

try {
  if (process.env.RENDER && !config.mongoUri) {
    console.warn('RENDER FREE: la sesión de WhatsApp está en almacenamiento temporal. Configura MONGODB_URI para que sobreviva reinicios/redeploys.');
  } else if (config.mongoUri) {
    console.log(`Persistencia Baileys: MongoDB · sesión ${config.baileysSessionId}.`);
  }
  bridge = config.source === 'sqlite' ? vipBridge(store) : config.source === 'vip-api' ? vipApiSource(store) : null;
  try { health.sourceHealthy = bridge ? await bridge.poll() : true; }
  catch (error) { health.sourceHealthy = false; console.error(error.message); }
  sender = await whatsapp(config);
  app = server(store, sender, health);
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(config.port, config.host, resolve); });
  console.log(`VIP NOTIFICACIONES: http://${config.host}:${config.port} | WhatsApp=${config.mode} | fuente=${config.source}`);
  if (process.env.RENDER) console.log('Administración WhatsApp: abre /admin/whatsapp en la URL pública de Render.');
  if (!routes.controlGroupId) console.log('Falta elegir el grupo. En Render usa /admin/whatsapp y luego guarda el ID en CONTROL_GROUP_ID para conservarlo entre reinicios.');
  if (!routes.defaultDoctorId) console.warn('Falta DOCTOR_PHONE: los recordatorios al médico no se podrán enviar.');
  if (config.source === 'webhook' && store.status().appointments === 0) console.warn('ATENCIÓN: 0 citas recibidas. Configura la fuente VIP.');
  if (process.env.MEDICONNECTA_LOOKUP !== 'true') console.warn('Consulta del médico en MediConecta desactivada: falta configurar acceso autorizado.');
  const tick = async () => {
    if (running || stopping) return;
    running = true;
    try {
      health.sourceHealthy = bridge ? await bridge.poll() : true;
      store.schedule();
      if (sender.ready) await store.deliver(sender);
    } catch (error) {
      health.sourceHealthy = false;
      console.error(error.message || 'No se pudo procesar la fuente/cola.');
    } finally { running = false; }
  };
  timer = setInterval(tick, config.pollSeconds * 1000);
  await tick();
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
} catch (error) {
  await shutdown();
  throw error;
}
