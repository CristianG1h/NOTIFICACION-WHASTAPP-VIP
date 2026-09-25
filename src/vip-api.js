import { snapshot } from './domain.js';
import { mediconecta } from './mediconecta.js';

export function vipApiSource(store, env = process.env, fetcher = fetch, providerOverride) {
  const url = new URL(env.VIP_API_BASE_URL || 'https://vip-teleconsulta-api.onrender.com');
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('VIP_API_BASE_URL debe ser el origen HTTPS del backend');
  if (!/^[a-f\d]{64}$/i.test(env.VIP_API_TOKEN || '')) throw new Error('Falta VIP_API_TOKEN, debe coincidir con NOTIFICATIONS_READ_TOKEN de Render');
  const provider = providerOverride === undefined ? mediconecta(store.config, store.routes, env, fetcher) : providerOverride;
  let first = !store.db.prepare("SELECT value FROM metadata WHERE key='vip_api_baseline'").get();
  return {
    async poll() {
      const records = []; const cursors = new Set(); let cursor = '';
      // Validate the entire paginated response before changing local state.
      do {
        const endpoint = new URL('/api/notifications/appointments', url);
        if (cursor) endpoint.searchParams.set('after', cursor);
        const response = await fetcher(endpoint, {
          headers: { Authorization: `Bearer ${env.VIP_API_TOKEN}`, Accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(15000), cache: 'no-store',
        });
        if (response.status === 404) throw new Error('La ruta de notificaciones no está desplegada en el backend VIP');
        if ([401, 403].includes(response.status)) throw new Error('VIP_API_TOKEN no coincide con NOTIFICATIONS_READ_TOKEN, o falta configurar Render');
        if (!response.ok) throw new Error('El backend VIP no está disponible');
        const body = await response.json();
        if (!Array.isArray(body.appointments) || body.appointments.length > 100 || (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !/^[\w-]{1,100}$/.test(body.nextCursor)))) throw new Error('Contrato de citas VIP inválido');
        records.push(...body.appointments.map(snapshot));
        cursor = body.nextCursor;
        if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('Paginación VIP incompleta; no se aplicó la sincronización');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      let healthy = true;
      for (const s of records) {
        const previous = store.get(s.id);
        let providerPaymentObserved = false;
        if (provider && s.status !== 'completed' && Date.parse(s.startsAt) > Date.now() - 120000) {
          try {
            const providerState = await provider.lookup(s.id);
            providerPaymentObserved = Object.hasOwn(providerState, 'payment');
            Object.assign(s, providerState);
          } catch (error) {
            // If MediConecta is temporarily unavailable, keep a previously
            // confirmed payment rather than inventing an unpaid state. A real
            // explicit pagado=false response is handled above and DOES downgrade.
            healthy = false;
            s.doctorId = 'PROVIDER_UNAVAILABLE';
            s.form = 'unknown';
            console.error(`MediConecta ${s.id}: ${error.message || 'consulta fallida'}`);
          }
        }
        // Preserve approved only when MediConecta did not provide an explicit
        // payment value. If it explicitly reports false/NO PAGADO, the new
        // manual_pending value must be accepted and notified.
        if (previous?.payment === 'approved' && s.payment === 'manual_pending' && provider && !providerPaymentObserved) s.payment = 'approved';
        if (previous && ['startsAt', 'doctorId', 'status', 'payment', 'form', 'patientName'].every(k => previous[k] === s[k])) continue;
        s.version = Math.max(Date.now(), (previous?.version || 0) + 1);
        // On first connection, notify upcoming appointments; don't replay old history.
        store.accept(s, Date.now(), first && !previous && Date.parse(s.startsAt) <= Date.now());
      }
      first = false;
      store.db.prepare("INSERT OR IGNORE INTO metadata VALUES('vip_api_baseline','done')").run();
      return healthy;
    },
    close() {},
  };
}
