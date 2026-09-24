import { routing } from '../src/config.js';
const routes = routing();
console.log(`WhatsApp: ${process.env.WHATSAPP_MODE || 'mock'} | fuente: ${process.env.SOURCE_MODE || 'webhook'}`);
console.log(`Grupo configurado: ${!!routes.controlGroupId} | médicos configurados: ${Object.keys(routes.doctors).length}`);
console.log(`Consulta a MediConecta activada: ${process.env.MEDICONNECTA_LOOKUP === 'true'} | acceso: ${process.env.MEDICONNECTA_AUTH_MODE || 'bearer'} | token presente: ${!!process.env.MEDICONNECTA_TOKEN}`);
try {
  const port = Number(process.env.PORT || 3210);
  const response = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: `Bearer ${process.env.API_TOKEN}` }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error();
  const status = await response.json();
  console.log(`Citas recibidas: ${status.appointments} | cola: ${JSON.stringify(status.jobs)}`);
} catch { console.log('El bot local no está iniciado o no permite consultar su estado.'); }
if ((process.env.SOURCE_MODE || 'webhook') === 'webhook') console.log('WEBHOOK: la web debe enviar eventos. Si no existe emisor, las citas nunca llegan. Usa vip-api después de desplegar el endpoint del backend.');
if (process.env.VIP_API_TOKEN) {
  try {
    const url = new URL('/api/notifications/appointments', process.env.VIP_API_BASE_URL);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error();
    const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.VIP_API_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    console.log(`Backend VIP: HTTP ${r.status}${r.status === 404 ? ' — falta desplegar el endpoint' : r.status === 403 ? ' — falta token en Render o no coincide' : ''}`);
  } catch { console.log('No se pudo verificar el backend VIP. Revisa URL y conectividad.'); }
} else console.log('Falta VIP_API_TOKEN para comprobar la conexión con el backend publicado.');
