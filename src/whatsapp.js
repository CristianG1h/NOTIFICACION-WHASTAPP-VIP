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

export async function whatsapp(config) {
  if (config.mode === 'mock') return {
    ready: true,
    phase: 'mock',
    qrDataUri: null,
    lastError: null,
    async send() { console.log(JSON.stringify({ event: 'simulated_delivery', mode: 'mock' })); },
    async close() {},
  };

  const { default: library } = await import('whatsapp-web.js');
  const { default: qr } = await import('qrcode-terminal');
  const client = new library.Client({
    authStrategy: new library.LocalAuth({ clientId: 'vip', dataPath: join(config.directory, 'whatsapp') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    },
  });

  const sender = {
    ready: false,
    phase: 'starting',
    qrDataUri: null,
    lastError: null,
    client,
    async send(target, text) {
      if (!sender.ready) throw new Error('WhatsApp desconectado');
      const destination = target.endsWith('@g.us') ? target : (await client.getNumberId(target))?._serialized;
      if (!destination) throw new Error('Número no disponible en WhatsApp');
      await client.sendMessage(destination, text, { linkPreview: false, sendSeen: false });
    },
    async close() {
      sender.ready = false;
      sender.phase = 'stopped';
      await client.destroy();
    },
  };

  client.on('qr', code => {
    sender.ready = false;
    sender.phase = 'qr';
    sender.lastError = null;
    sender.qrDataUri = svgQrDataUri(code);
    console.log('WhatsApp > Dispositivos vinculados > Vincular un dispositivo. Escanea este QR:');
    qr.generate(code, { small: true });
    console.log('También puedes abrir /admin/whatsapp en la URL pública del servicio y usar API_TOKEN.');
  });
  client.on('authenticated', () => {
    sender.phase = 'authenticated';
    sender.lastError = null;
    console.log('WhatsApp autenticado; esperando sincronización.');
  });
  client.on('ready', () => {
    sender.ready = true;
    sender.phase = 'ready';
    sender.qrDataUri = null;
    sender.lastError = null;
    console.log('WhatsApp conectado.');
  });
  client.on('auth_failure', message => {
    sender.ready = false;
    sender.phase = 'auth_failure';
    sender.lastError = String(message || 'Falló la autenticación');
    console.error('Falló la autenticación. Abre /admin/whatsapp para volver a vincular.');
  });
  client.on('disconnected', reason => {
    sender.ready = false;
    sender.phase = 'disconnected';
    sender.lastError = String(reason || 'WhatsApp desconectado');
    console.error('WhatsApp desconectado. Revisa /admin/whatsapp y vuelve a vincular si se solicita.');
  });

  // initialize puede esperar el QR. El servidor HTTP y la cola continúan disponibles.
  sender.initializing = client.initialize().catch(error => {
    sender.ready = false;
    sender.phase = 'error';
    sender.lastError = error?.message || 'No se pudo iniciar WhatsApp/Chrome';
    console.error(sender.lastError);
  });
  return sender;
}
