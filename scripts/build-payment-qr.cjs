// Run with the decoded QR payload from the supplied PDF. No banking field is edited.
const fs = require('node:fs');
const crypto = require('node:crypto');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const levels = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const input = process.argv[2];
if (!input) throw new Error('Uso: node scripts/build-payment-qr.cjs <archivo-del-contenido-QR>');
const bytes = fs.readFileSync(input);
if ([...bytes].some(byte => byte > 127)) throw new Error('Se requiere contenido ASCII para preservar exactamente los bytes.');
const qr = new QRCode(-1, levels.M);
qr.addData(bytes.toString('ascii')); qr.make();
const count = qr.getModuleCount(), quiet = 4, size = count + quiet * 2;
const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><title>QR de pago VIP Salud Ocupacional</title><rect width="${size}" height="${size}" fill="white"/>`];
for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) parts.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1" fill="#071b33"/>`);
parts.push('</svg>');
fs.mkdirSync('public/payments', { recursive: true });
fs.writeFileSync('public/payments/qr-vip.svg', parts.join(''));
fs.writeFileSync('public/payments/qr-verification.json', JSON.stringify({ source: 'CamScanner 14-07-26 13.22.pdf', payloadBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), quietZoneModules: quiet, modules: count, errorCorrection: 'M' }, null, 2) + '\n');
console.log(`QR generado conservando ${bytes.length} bytes; ${count} módulos.`);
