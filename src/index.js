import { configuration, routing } from './config.js';
import { Store } from './store.js';
import { whatsapp } from './whatsapp.js';
import { vipBridge } from './bridge.js';
import { server } from './server.js';
import { vipApiSource } from './vip-api.js';
import { openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Doctors, doctorRepository } from './doctors.js';
import { Conversation } from './conversation.js';
import { stateRepository } from './state-repository.js';

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

let bridge, sender, app, timer, directoryRepository, persistence, persistenceRestored = false, running = false, stopping = false;
const health = { sourceHealthy: true, startupPhase: 'booting' };

// Render hace deploy zero-downtime: el proceso anterior sigue vivo mientras arranca
// el nuevo. Este proxy permite levantar HTTP/health primero, pero NO inicia un segundo
// WhatsApp hasta que el deploy anterior libere el lease de MongoDB.
const senderProxy = {
  get ready() { return !!sender?.ready; },
  get phase() { return sender?.phase || (health.startupPhase === 'waiting-lock' ? 'waiting-mongodb-lock' : 'starting'); },
  get authStorage() { return sender?.authStorage || 'unknown'; },
  get authSessionId() { return sender?.authSessionId || null; },
  get qrDataUri() { return sender?.qrDataUri || null; },
  get lastError() { return sender?.lastError || null; },
  async authStatus() { return typeof sender?.authStatus === 'function' ? sender.authStatus() : null; },
  async listGroups() {
    if (!sender?.ready) throw new Error('WhatsApp aún no está conectado');
    return sender.listGroups();
  },
};

async function shutdown() {
  if (stopping) return;
  stopping = true;
  health.startupPhase = 'stopping';
  clearInterval(timer);
  if (app?.listening) await new Promise(resolve => app.close(resolve));
  while (running) await new Promise(resolve => setTimeout(resolve, 50));
  await sender?.close().catch(() => {});
  bridge?.close();
  if (persistenceRestored) await persistence?.save().catch(() => {});
  await persistence?.close();
  await directoryRepository?.close();
  store.close();
  if (descriptor !== undefined) {
    closeSync(descriptor);
    try { unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

try {
  // IMPORTANTE: escuchar HTTP antes de pedir el lease.
  // Así Render puede validar /health y retirar correctamente el deploy anterior,
  // que entonces libera su lease MongoDB.
  app = server(store, senderProxy, health);
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(config.port, config.host, resolve);
  });
  console.log(`VIP NOTIFICACIONES HTTP: http://${config.host}:${config.port} | inicio=${health.startupPhase}`);

  health.startupPhase = 'waiting-lock';
  persistence = await stateRepository(config, store);

  health.startupPhase = 'restoring-state';
  await persistence?.restore();
  persistenceRestored = true;

  const savedGroup = store.db.prepare("SELECT value FROM metadata WHERE key='control_group'").get();
  if (!process.env.CONTROL_GROUP_ID && savedGroup) routes.controlGroupId = savedGroup.value;
  store.persist = () => persistence?.save();

  health.startupPhase = 'loading-doctors';
  directoryRepository = await doctorRepository(config, store);
  const doctors = new Doctors(store, directoryRepository);
  await doctors.initialize();
  const conversation = new Conversation(store, doctors);

  if (process.env.RENDER && !config.mongoUri) {
    console.warn('RENDER FREE: la sesión de WhatsApp está en almacenamiento temporal. Configura MONGODB_URI para que sobreviva reinicios/redeploys.');
  } else if (config.mongoUri) {
    console.log(`Persistencia Baileys: MongoDB · sesión ${config.baileysSessionId}.`);
  }

  health.startupPhase = 'loading-source';
  bridge = config.source === 'sqlite' ? vipBridge(store) : config.source === 'vip-api' ? vipApiSource(store) : null;
  try { health.sourceHealthy = bridge ? await bridge.poll() : true; }
  catch (error) { health.sourceHealthy = false; console.error(error.message); }

  health.startupPhase = 'connecting-whatsapp';
  sender = await whatsapp(config, async incoming => {
    persistence?.assertActive();
    await conversation.receive(incoming);
    await persistence?.save();
    // Menus and confirmations should not wait for the next source poll. Medical
    // reminders remain restricted to the worker that just refreshed the source.
    if (sender?.ready) await store.deliver({ send: async (...args) => { persistence?.assertActive(); return sender.send(...args); } }, Date.now(), { sourceHealthy: false });
  });

  health.startupPhase = 'ready';
  console.log(`VIP NOTIFICACIONES: http://${config.host}:${config.port} | WhatsApp=${config.mode} | fuente=${config.source}`);
  if (process.env.RENDER) console.log('Administración WhatsApp: abre /admin/whatsapp en la URL pública de Render.');
  if (!routes.controlGroupId) console.log('Falta elegir el grupo. En Render usa /admin/whatsapp y luego guarda el ID en CONTROL_GROUP_ID para conservarlo entre reinicios.');
  if (!Object.keys(routes.doctors).length) console.warn('Sin médicos: un administrador debe escribir MEDICO al WhatsApp del bot.');
  if (config.source === 'webhook' && store.status().appointments === 0) console.warn('ATENCIÓN: 0 citas recibidas. Configura la fuente VIP.');
  if (process.env.MEDICONNECTA_LOOKUP !== 'true') console.warn('Consulta del médico en MediConecta desactivada: falta configurar acceso autorizado.');

  const tick = async () => {
    if (running || stopping) return;
    running = true;
    try {
      try { health.sourceHealthy = bridge ? await bridge.poll() : true; }
      catch (error) { health.sourceHealthy = false; console.error(error.message || 'No se pudo actualizar la fuente.'); }
      if (health.sourceHealthy) store.schedule();
      await persistence?.save();
      if (sender.ready) await store.deliver({ send: async (...args) => { persistence?.assertActive(); return sender.send(...args); } }, Date.now(), { sourceHealthy: health.sourceHealthy });
      await persistence?.save();
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
