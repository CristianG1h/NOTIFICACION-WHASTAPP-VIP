import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
const directory = mkdtempSync(join(tmpdir(), 'vip-notificaciones-demo-'));
const config = { directory, mode: 'mock', key: randomBytes(32), base: 'https://vip-mediconecta.app', reminderMinutes: 15 };
const store = new Store(config, { controlGroupId: 'demo@g.us', doctors: { demo: '573000000000' }, assignments: {}, defaultDoctorId: 'demo' });
try {
  const s = { id: 'DEMO-CITA-001', version: 1, startsAt: new Date(Date.now() + 10 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'), status: 'confirmed', payment: 'pending', form: 'unknown' };
  store.accept(s);
  store.accept({ ...s, version: 2, payment: 'approved', form: 'completed' });
  store.schedule();
  await store.deliver({ async send(target, text) { console.log(`\n--- SIMULACIÓN: ${target.endsWith('@g.us') ? 'GRUPO' : 'MÉDICO'} ---\n${text}`); } });
  console.log('\nPrueba terminada sin conectar WhatsApp ni enviar mensajes.');
} finally { store.close(); rmSync(directory, { recursive: true }); }
