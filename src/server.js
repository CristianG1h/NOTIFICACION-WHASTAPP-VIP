import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InputError } from './domain.js';

export function authorized(value, token) {
  const actual = Buffer.from(String(value || ''));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function adminPage() {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIP Notificaciones · WhatsApp</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f7f6;color:#14201b;margin:0;padding:24px}.card{max-width:720px;margin:auto;background:#fff;border-radius:18px;padding:24px;box-shadow:0 12px 40px #0001}h1{margin-top:0}input,button,select{font:inherit;padding:11px 12px;border-radius:10px;border:1px solid #cbd5d1}input{width:min(520px,calc(100% - 26px))}button{cursor:pointer;background:#176b47;color:white;border:0}.muted{color:#5f6f68}.ok{color:#08783e;font-weight:700}.bad{color:#a32929;font-weight:700}.qr{display:none;max-width:360px;width:100%;margin:18px auto;background:white}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.box{margin-top:18px;padding:16px;border:1px solid #e0e7e4;border-radius:14px}code{word-break:break-all}</style></head>
<body><div class="card"><h1>VIP Notificaciones · WhatsApp</h1>
<p class="muted">Esta página no muestra datos hasta que ingreses el <b>API_TOKEN</b> configurado en Render. El token se usa solo en tu navegador y no se coloca en la URL.</p>
<div class="row"><input id="token" type="password" placeholder="API_TOKEN de Render"><button id="connect">Consultar</button></div>
<div class="box"><div id="state" class="muted">Sin consultar.</div><img id="qr" class="qr" alt="QR de WhatsApp"></div>
<div class="box"><h3>Grupo de control</h3><p class="muted">Cuando WhatsApp esté conectado, carga los grupos, elige el de Control Teleconsultas VIP y guárdalo. En Render Free, después de guardar copia el ID mostrado a CONTROL_GROUP_ID en Environment para conservarlo entre reinicios.</p>
<div class="row"><button id="loadGroups">Cargar grupos</button><select id="groups"><option value="">—</option></select><button id="saveGroup">Guardar grupo</button></div><div id="groupMsg" class="muted"></div></div>
</div><script>
let token=''; const state=document.getElementById('state'), qr=document.getElementById('qr');
async function api(path, options={}){const r=await fetch(path,{...options,headers:{...(options.headers||{}),Authorization:'Bearer '+token}});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||('HTTP '+r.status));return data}
async function refresh(){if(!token)return;try{const x=await api('/admin/whatsapp/state');state.className=x.ready?'ok':(x.lastError?'bad':'muted');state.textContent=x.ready?'WhatsApp conectado.':('Estado: '+x.phase+(x.lastError?' · '+x.lastError:''));if(x.qrDataUri){qr.src=x.qrDataUri;qr.style.display='block'}else{qr.style.display='none'}}catch(e){state.className='bad';state.textContent=e.message}}
document.getElementById('connect').onclick=()=>{token=document.getElementById('token').value.trim();refresh()};
document.getElementById('loadGroups').onclick=async()=>{try{const x=await api('/admin/whatsapp/groups');const s=document.getElementById('groups');s.innerHTML='<option value="">Selecciona un grupo</option>';for(const g of x.groups){const o=document.createElement('option');o.value=g.id;o.textContent=g.name+' — '+g.id;s.appendChild(o)}}catch(e){document.getElementById('groupMsg').textContent=e.message}};
document.getElementById('saveGroup').onclick=async()=>{try{const id=document.getElementById('groups').value;if(!id)throw new Error('Selecciona un grupo');const x=await api('/admin/whatsapp/control-group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});document.getElementById('groupMsg').textContent='Guardado temporalmente: '+x.controlGroupId+' · Copia este ID a CONTROL_GROUP_ID en Render para conservarlo.'}catch(e){document.getElementById('groupMsg').textContent=e.message}};
setInterval(refresh,3000);
</script></body></html>`;
}

async function bodyJson(req, limit = 16384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new InputError('Solicitud demasiado grande', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw new InputError('JSON inválido'); }
}

export function server(store, sender, health = {}) {
  const app = createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'GET' && req.url === '/') return json(200, { service: 'vip-notificaciones', health: '/health', whatsappAdmin: '/admin/whatsapp' });
      if (req.method === 'GET' && req.url === '/health') return json(200, { service: 'vip-notificaciones', mode: store.config.mode, source: store.config.source, whatsappReady: sender.ready, whatsappPhase: sender.phase || (sender.ready ? 'ready' : 'starting'), sourceHealthy: health.sourceHealthy ?? true, awaitingEvents: store.config.source === 'webhook' && store.status().appointments === 0 });
      if (req.method === 'GET' && req.url === '/admin/whatsapp') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
        return res.end(adminPage());
      }
      if (!authorized(req.headers.authorization, store.config.token)) return json(401, { error: 'No autorizado' });
      if (req.method === 'GET' && req.url === '/admin/whatsapp/state') return json(200, { ready: !!sender.ready, phase: sender.phase || (sender.ready ? 'ready' : 'starting'), qrDataUri: sender.qrDataUri || null, lastError: sender.lastError || null, controlGroupId: store.routes.controlGroupId || '' });
      if (req.method === 'GET' && req.url === '/admin/whatsapp/groups') {
        if (!sender.ready) return json(409, { error: 'WhatsApp aún no está conectado' });
        const groups = await sender.listGroups();
        return json(200, { groups });
      }
      if (req.method === 'POST' && req.url === '/admin/whatsapp/control-group') {
        if (!String(req.headers['content-type']).startsWith('application/json')) return json(415, { error: 'Usa application/json' });
        const input = await bodyJson(req);
        if (typeof input.id !== 'string' || !/^\d+(?:-\d+)?@g\.us$/.test(input.id)) throw new InputError('ID de grupo inválido');
        if (sender.ready) {
          const groups = await sender.listGroups();
          if (!groups.some(g => g.id === input.id)) throw new InputError('Ese grupo no pertenece al WhatsApp conectado', 409);
        }
        store.routes.controlGroupId = input.id;
        writeFileSync(join(store.config.directory, 'routing.runtime.json'), JSON.stringify({ controlGroupId: input.id }, null, 2) + '\n', { mode: 0o600 });
        return json(200, { saved: true, controlGroupId: input.id });
      }
      if (req.method === 'GET' && req.url === '/status') return json(200, store.status());
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (req.method === 'GET' && req.url === '/local/upcoming' && local) return json(200, store.upcoming());
      const testDoctor = req.url === '/local/test-doctor' && local;
      if (req.method !== 'POST' || (!testDoctor && req.url !== '/events/appointment')) return json(404, { error: 'Ruta inexistente' });
      if (!testDoctor && store.config.source !== 'webhook') return json(409, { error: 'Eventos externos desactivados para evitar mezclar fuentes' });
      if (!String(req.headers['content-type']).startsWith('application/json')) return json(415, { error: 'Usa application/json' });
      const input = await bodyJson(req);
      if (testDoctor) {
        if (!sender.ready) return json(409, { error: 'WhatsApp aún no está conectado' });
        if (!input || typeof input !== 'object') throw new InputError('JSON inválido');
        return json(202, store.testDoctor(input.id, input.requestId));
      }
      return json(202, store.accept(input));
    } catch (error) {
      return json(error instanceof InputError ? error.status : 500, { error: error instanceof InputError ? error.message : 'No se pudo procesar la solicitud' });
    }
  });
  app.requestTimeout = 15000;
  app.headersTimeout = 10000;
  return app;
}
