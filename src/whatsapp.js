import { join } from 'node:path';
import { createRequire } from 'node:module';

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
    async send() { console.log(JSON.stringify({ event: 'simulated_delivery', mode: 'mock' })); },
    async listGroups() { return []; },
    async close() {},
  };

  const baileys = await import('@whiskeysockets/baileys');
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = baileys;
  const { default: qrTerminal } = await import('qrcode-terminal');
  const authDirectory = join(config.directory, 'baileys-auth');
  const { state, saveCreds } = await useMultiFileAuthState(authDirectory);

  const sender = {
    ready: false,
    phase: 'starting',
    qrDataUri: null,
    lastError: null,
    socket: null,
    stopped: false,
    reconnectTimer: null,
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
    async close() {
      sender.stopped = true;
      sender.ready = false;
      sender.phase = 'stopped';
      if (sender.reconnectTimer) clearTimeout(sender.reconnectTimer);
      try { sender.socket?.ws?.close?.(); } catch {}
      sender.socket = null;
    },
  };

  async function connect() {
    if (sender.stopped) return;
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

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', update => {
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
        console.log('WhatsApp conectado con Baileys.');
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
