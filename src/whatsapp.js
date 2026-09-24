import { join } from 'node:path';
import { createRequire } from 'node:module';
import { useMongoAuthState } from './baileys-mongo-auth.js';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

function svgQrDataUri(value) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`, '<rect width="100%" height="100%" fill="white"/>'];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) parts.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1" fill="black"/>`);
    }
  }
  parts.push('</svg>');
  return `data:image/svg+xml;base64,${Buffer.from(parts.join('')).toString('base64')}`;
}

function disconnectCode(error) {
  return Number(
    error?.output?.statusCode ||
    error?.statusCode ||
    error?.data?.statusCode ||
    error?.cause?.output?.statusCode ||
    error?.cause?.statusCode ||
    0
  );
}

export async function whatsapp(config) {
  if (config.mode === 'mock') return {
    ready: true,
    phase: 'mock',
    qrDataUri: null,
    lastError: null,
    socket: null,
    authStorage: 'mock',
    authSessionId: null,
    async send() { console.log(JSON.stringify({ event: 'simulated_delivery', mode: 'mock' })); },
    async listGroups() { return []; },
    async close() {},
  };

  const baileys = await import('@whiskeysockets/baileys');
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = baileys;
  const { default: qrTerminal } = await import('qrcode-terminal');

  let auth;
  if (config.mongoUri) {
    console.log(`Baileys: cargando sesión persistente '${config.baileysSessionId}' desde MongoDB...`);
    auth = await useMongoAuthState({
      uri: config.mongoUri,
      sessionId: config.baileysSessionId,
      databaseName: config.mongoDatabase,
    });
    console.log('Baileys: MongoDB conectado; la sesión sobrevivirá reinicios/redeploys de Render.');
  } else {
    const authDirectory = join(config.directory, 'baileys-auth');
    const local = await useMultiFileAuthState(authDirectory);
    auth = { ...local, storage: 'local', close: async () => {}, clear: async () => {} };
    console.warn('Baileys: usando sesión LOCAL. Configura MONGODB_URI para persistir la sesión fuera de Render.');
  }

  const state = auth.state;
  const saveCreds = auth.saveCreds;

  const sender = {
    ready: false,
    phase: 'starting',
    qrDataUri: null,
    lastError: null,
    socket: null,
    stopped: false,
    reconnectTimer: null,
    authStorage: auth.storage,
    authSessionId: config.baileysSessionId,
    connectionGeneration: 0,
    authSavePromise: Promise.resolve(),
    async send(target, text) {
      if (!sender.ready || !sender.socket) throw new Error('WhatsApp desconectado');
      let destination = target;
      if (!/@(?:g\.us|s\.whatsapp\.net|lid)$/.test(destination)) {
        const result = await sender.socket.onWhatsApp(`${String(target).replace(/\D/g, '')}@s.whatsapp.net`);
        const found = Array.isArray(result) ? result.find(item => item?.exists && item?.jid) : null;
        if (!found?.jid) throw new Error('Número no disponible en WhatsApp');
        destination = found.jid;
      }
      await sender.socket.sendMessage(destination, { text });
    },
    async listGroups() {
      if (!sender.ready || !sender.socket) throw new Error('WhatsApp aún no está conectado');
      const metadata = await sender.socket.groupFetchAllParticipating();
      return Object.values(metadata || {})
        .filter(group => group && typeof group.id === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(group.id))
        .map(group => ({ id: group.id, name: String(group.subject || group.id) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    },
    async authStatus() {
      if (typeof auth.status === 'function') return auth.status();
      return { storage: auth.storage, sessionId: config.baileysSessionId, documents: null };
    },
    async close() {
      sender.stopped = true;
      sender.ready = false;
      sender.phase = 'stopped';
      sender.connectionGeneration += 1;
      if (sender.reconnectTimer) clearTimeout(sender.reconnectTimer);
      try { sender.socket?.ws?.close?.(); } catch {}
      sender.socket = null;
      await sender.authSavePromise.catch(() => {});
      await auth.close?.();
    },
  };

  async function connect() {
    if (sender.stopped) return;
    const generation = ++sender.connectionGeneration;
    sender.phase = state.creds.registered ? 'connecting' : 'waiting_qr';
    sender.lastError = null;

    const socket = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu('VIP Notificaciones'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });
    sender.socket = socket;

    socket.ev.on('creds.update', () => {
      sender.authSavePromise = sender.authSavePromise
        .catch(() => {})
        .then(() => saveCreds())
        .catch(error => {
          sender.lastError = `No se pudo guardar la sesión de WhatsApp: ${error?.message || 'MongoDB'}`;
          console.error(sender.lastError);
        });
    });

    socket.ev.on('connection.update', update => {
      if (generation !== sender.connectionGeneration) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        sender.ready = false;
        sender.phase = 'qr';
        sender.lastError = null;
        sender.qrDataUri = svgQrDataUri(qr);
        console.log('WhatsApp > Dispositivos vinculados > Vincular un dispositivo. Escanea este QR:');
        qrTerminal.generate(qr, { small: true });
        console.log('También puedes abrir /admin/whatsapp y usar API_TOKEN.');
      }
      if (connection === 'open') {
        sender.ready = true;
        sender.phase = 'ready';
        sender.qrDataUri = null;
        sender.lastError = null;
        console.log(`WhatsApp conectado con Baileys. Sesión=${auth.storage}${auth.storage === 'mongodb' ? ` (${config.baileysSessionId})` : ''}.`);
      }
      if (connection === 'close') {
        sender.ready = false;
        const code = disconnectCode(lastDisconnect?.error);
        const loggedOut = code === DisconnectReason.loggedOut;
        sender.phase = loggedOut ? 'logged_out' : 'disconnected';
        sender.lastError = loggedOut
          ? 'La sesión fue cerrada desde WhatsApp. Debes volver a vincular.'
          : `Conexión cerrada${code ? ` (código ${code})` : ''}; intentando reconectar.`;
        if (loggedOut) {
          sender.qrDataUri = null;
          console.error(sender.lastError);
        } else if (!sender.stopped) {
          console.warn(sender.lastError);
          if (sender.reconnectTimer) clearTimeout(sender.reconnectTimer);
          sender.reconnectTimer = setTimeout(() => { void connect().catch(error => {
            sender.phase = 'error';
            sender.lastError = error?.message || 'No se pudo reconectar WhatsApp';
            console.error(sender.lastError);
          }); }, 2000);
        }
      }
    });
  }

  sender.initializing = connect().catch(error => {
    sender.ready = false;
    sender.phase = 'error';
    sender.lastError = error?.message || 'No se pudo iniciar Baileys';
    console.error(sender.lastError);
  });

  return sender;
}
