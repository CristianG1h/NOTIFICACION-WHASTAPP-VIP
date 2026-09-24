import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { message, snapshot } from '../src/domain.js';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'vip-timing-'));
  const store = new Store({ directory, mode: 'mock', key: randomBytes(32), base: 'https://vip-mediconecta.app', reminderMinutes: 15 }, { doctors: { doctor: '573000000000' }, assignments: {}, controlGroupId: '' });
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  return store;
}
test('name replaces reference in both recipient messages', () => {
  const s = snapshot({ id: 'private-order-id', patientName: 'Ana María Pérez', version: 1, startsAt: '2027-01-01T10:00:00-05:00' });
  for (const kind of ['created', 'updated', 'reminder']) {
    const text = message(s, kind, 'https://vip-mediconecta.app');
    assert.match(text, /Paciente: Ana María Pérez/);
    assert.doesNotMatch(text, /Referencia:/);
    if (kind !== 'reminder') assert.doesNotMatch(text, /private-order-id/);
  }
});
test('near appointments notify now; distant wait; exact 15 minute boundary is included', t => {
  const store = fixture(t), now = Date.now();
  for (const minutes of [1, 5, 15, 16, 40, -1]) store.accept({ id: `order-${minutes}`, version: 1, doctorId: 'doctor', startsAt: new Date(now + minutes * 60000).toISOString() });
  store.schedule(now);
  const queued = store.db.prepare("SELECT appointment FROM jobs WHERE kind='reminder'").all().map(r => r.appointment).sort();
  assert.deepEqual(queued, ['order-1', 'order-15', 'order-5']);
});
test('manual early test is idempotent per request and leaves scheduled reminder intact', async t => {
  const store = fixture(t), now = Date.now();
  const s = { id: 'order-test', version: 1, patientName: 'Paciente de prueba', doctorId: 'doctor', startsAt: new Date(now + 40 * 60000).toISOString() };
  store.accept(s); store.schedule(now);
  assert.equal(store.status().jobs.length, 0);
  const requestId = randomUUID();
  store.testDoctor(s.id, requestId, now); store.testDoctor(s.id, requestId, now);
  const sent = [];
  await store.deliver({ async send(to, text) { sent.push(text); } }, now);
  assert.equal(sent.length, 1); assert.match(sent[0], /PRUEBA LOCAL/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 0);
  store.schedule(now + 25 * 60000);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='reminder' AND state='pending'").get().n, 1);
});
test('manual test blocks missing physician, past and cancelled appointments', t => {
  const store = fixture(t), now = Date.now();
  for (const s of [
    { id: 'missing', doctorId: null, startsAt: new Date(now + 600000).toISOString() },
    { id: 'past', doctorId: 'doctor', startsAt: new Date(now - 600000).toISOString() },
    { id: 'cancelled', doctorId: 'doctor', status: 'cancelled', startsAt: new Date(now + 600000).toISOString() },
  ]) { store.accept({ version: 1, ...s }); assert.throws(() => store.testDoctor(s.id, randomUUID(), now)); }
});
