import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { snapshot } from './domain.js';
import { mediconecta } from './mediconecta.js';

export function decodeRecord(data, key) {
  const bytes = Buffer.from(data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
}
export function fromVipRow(row, key, routes) {
  const data = decodeRecord(row.data, key);
  if (!data.externalId || !data.patient || row.state === 'draft') return null;
  const status = data.attention === 'completed' ? 'completed' : row.state;
  return snapshot({
    id: data.externalId, version: row.updated,
    patientName: [data.patient.firstName, data.patient.middleName, data.patient.lastName, data.patient.secondLastName].filter(Boolean).join(' '),
    startsAt: `${data.patient.date}T${data.patient.time}:00-05:00`,
    status, payment: row.payment, form: 'unknown',
    doctorId: null,
  });
}
export function vipBridge(store, env = process.env, providerOverride) {
  const file = env.VIP_DATABASE_PATH;
  if (!file || !existsSync(file)) throw new Error('VIP_DATABASE_PATH debe apuntar a la base SQLite existente del backend');
  const key = env.VIP_DATA_ENCRYPTION_KEY ? Buffer.from(env.VIP_DATA_ENCRYPTION_KEY, 'hex') : env.VIP_DEVELOPMENT_KEY_PATH ? readFileSync(env.VIP_DEVELOPMENT_KEY_PATH) : null;
  if (!key || key.length !== 32) throw new Error('Configura la clave de cifrado del backend VIP');
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000');
  const provider = providerOverride === undefined ? mediconecta(store.config, store.routes, env) : providerOverride;
  let first = !store.db.prepare("SELECT value FROM metadata WHERE key='vip_baseline'").get();
  return {
    async poll() {
      // Full snapshots avoid timestamp/cursor races; encrypted source stays read-only.
      // On first observation of existing appointments suppress historical group alerts.
      const rows = db.prepare("SELECT state,payment,data,updated FROM requests WHERE state != 'draft'").all();
      let providerHealthy = true;
      for (const row of rows) {
        const s = fromVipRow(row, key, store.routes);
        if (!s) continue;
        const previous = store.get(s.id);
        if (provider && s.status !== 'completed' && Date.parse(s.startsAt) > Date.now()) {
          try { Object.assign(s, await provider.lookup(s.id)); }
          catch {
            providerHealthy = false;
            // Explicit unknown ID prevents default/manual routing after an API failure.
            s.doctorId = 'PROVIDER_UNAVAILABLE'; s.form = 'unknown';
          }
        }
        if (previous && ['startsAt', 'doctorId', 'status', 'payment', 'form', 'patientName'].every(k => previous[k] === s[k])) continue;
        // Local revision includes both VIP and MediConecta changes; clocks need not match.
        s.version = Math.max(Date.now(), (previous?.version || 0) + 1);
        store.accept(s, Date.now(), first && !previous);
      }
      first = false;
      store.db.prepare("INSERT OR IGNORE INTO metadata VALUES('vip_baseline','done')").run();
      return providerHealthy;
    },
    close() { db.close(); },
  };
}
