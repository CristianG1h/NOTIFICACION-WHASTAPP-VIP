import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { vipApiSource } from '../src/vip-api.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'vip-api-test-'));
  const store = new Store({ directory, key: randomBytes(32), mode: 'mock', reminderMinutes: 15, base: 'https://vip-mediconecta.app' }, { controlGroupId: '123@g.us', doctors: { YULI: '573000000000' }, assignments: {} });
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  return { store, env: { VIP_API_BASE_URL: 'https://backend.example', VIP_API_TOKEN: 'a'.repeat(64) }, s: { id: 'order-vip-1', version: 1, status: 'confirmed', startsAt: new Date(Date.now() + 600000).toISOString(), payment: 'manual_pending', form: 'unknown', doctorId: null } };
}
test('API -> local queue -> control group; repeat polls do not duplicate and payments update', async t => {
  const { store, env, s } = fixture(t);
  let current = s;
  const source = vipApiSource(store, env, async (url, options) => {
    assert.equal(url.pathname, '/api/notifications/appointments');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${env.VIP_API_TOKEN}`);
    return { ok: true, status: 200, async json() { return { appointments: [current], nextCursor: null }; } };
  }, null);
  await source.poll(); await source.poll();
  const sent = [];
  await store.deliver({ async send(target, text) { sent.push({ target, text }); } });
  assert.equal(sent.length, 1); assert.equal(sent[0].target, '123@g.us'); assert.match(sent[0].text, /Nueva cita/);
  current = { ...s, version: 2, payment: 'approved' }; await source.poll();
  await store.deliver({ async send(target, text) { sent.push({ target, text }); } });
  assert.equal(sent.length, 2); assert.match(sent[1].text, /Pago: Pagado/);
});
test('provider enriches remote VIP orders and unknown provider blocks doctor reminders', async t => {
  const { store, env, s } = fixture(t);
  let fail = false;
  const source = vipApiSource(store, env, async () => ({ ok: true, status: 200, async json() { return { appointments: [s], nextCursor: null }; } }), {
    async lookup(id) { assert.equal(id, s.id); if (fail) throw new Error(); return { doctorId: 'YULI', form: 'received' }; },
  });
  await source.poll(); store.schedule();
  assert.equal(store.get(s.id).doctorId, 'YULI');
  fail = true; assert.equal(await source.poll(), false);
  assert.equal(store.get(s.id).doctorId, 'PROVIDER_UNAVAILABLE');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='reminder' AND state='pending'").get().n, 0);
});
test('404/auth failure and invalid pagination do not claim successful synchronization', async t => {
  const { store, env, s } = fixture(t);
  await assert.rejects(vipApiSource(store, env, async () => ({ ok: false, status: 404 }), null).poll(), /no está desplegada/);
  await assert.rejects(vipApiSource(store, env, async () => ({ ok: false, status: 403 }), null).poll(), /no coincide/);
  await assert.rejects(vipApiSource(store, env, async () => ({ ok: true, status: 200, async json() { return { appointments: [s], nextCursor: 'repeat' }; } }), null).poll(), /Paginación/);
  assert.equal(store.status().appointments, 0);
});

test('an approved payment is not downgraded to manual_pending on a later provider miss', async t => {
  const { store, env, s } = fixture(t);
  let current = { ...s, payment: 'approved' };
  let providerOk = true;
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ appointments: [current], nextCursor: null }),
  });
  const provider = {
    async lookup() {
      if (providerOk) return {};
      throw new Error('temporal');
    },
  };
  const source = vipApiSource(store, env, fetcher, provider);
  await source.poll();
  assert.equal(store.get(s.id).payment, 'approved');
  providerOk = false;
  current = { ...s, version: 2, payment: 'manual_pending' };
  await source.poll();
  assert.equal(store.get(s.id).payment, 'approved');
});
