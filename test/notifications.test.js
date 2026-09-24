import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { snapshot, selectedDoctor } from '../src/domain.js';
import { server } from '../src/server.js';
import { vipBridge } from '../src/bridge.js';
import { mediconecta, providerFields } from '../src/mediconecta.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'vip-bot-test-'));
  const config = { directory, mode: 'mock', source: 'webhook', key: randomBytes(32), token: 'a'.repeat(64), base: 'https://vip-mediconecta.app', reminderMinutes: 15 };
  const routes = { controlGroupId: '123@g.us', doctors: { medico1: '573001111111', medico2: '573002222222' }, assignments: {}, defaultDoctorId: '' };
  const store = new Store(config, routes);
  const cleanup = [];
  t.after(() => { cleanup.forEach(fn => fn()); store.close(); rmSync(directory, { recursive: true }); });
  const s = { id: 'cita-1', version: 1, startsAt: new Date(Date.now() + 10 * 60000).toISOString(), doctorId: 'medico1', status: 'confirmed', payment: 'pending', form: 'unknown' };
  return { directory, config, routes, store, s, cleanup };
}
test('new appointment -> group; verified payment/form -> latest doctor reminder', async t => {
  const { store, s } = fixture(t);
  store.accept(s); store.accept({ ...s, version: 2, payment: 'approved', form: 'completed' }); store.schedule();
  const sent = [];
  await store.deliver({ async send(target, text) { sent.push({ target, text }); } });
  assert.equal(sent.length, 3);
  assert.equal(sent[0].target, '123@g.us');
  assert.match(sent[0].text, /Nueva cita/);
  assert.doesNotMatch(sent[0].text, /https:/);
  assert.equal(sent[2].target, '573001111111');
  assert.match(sent[2].text, /Pago: Pagado/);
  assert.match(sent[2].text, /Formulario: Completado/);
  assert.match(sent[2].text, /https:\/\/medico\.vip-mediconecta\.app\/panel-medico/);
});
test('duplicates, out of order delivery, and version collisions', t => {
  const { store, s } = fixture(t);
  store.accept({ ...s, version: 2 });
  assert.equal(store.accept({ ...s, version: 2 }).accepted, false);
  assert.equal(store.accept(s).accepted, false);
  assert.throws(() => store.accept({ ...s, version: 2, payment: 'approved' }), /distinto/);
  assert.equal(store.get(s.id).payment, 'pending');
  assert.equal(store.status().jobs[0].count, 1);
});
test('reschedule/cancel removes queued reminders and does not deliver past appointments', async t => {
  const { store, s } = fixture(t);
  store.accept(s); store.schedule();
  store.accept({ ...s, version: 2, status: 'cancelled' }); store.schedule();
  const sent = [];
  await store.deliver({ async send(target) { sent.push(target); } });
  assert.deepEqual(sent, ['123@g.us', '123@g.us']);
  store.accept({ ...s, version: 3, startsAt: new Date(Date.now() - 1000).toISOString() }); store.schedule();
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='reminder' AND state='pending'").get().n, 0);
});
test('update queued reminder, doctor reassignment and no repeat after delivery', async t => {
  const { store, s } = fixture(t);
  store.accept(s); store.schedule();
  store.accept({ ...s, version: 2, doctorId: 'medico2', payment: 'approved' }); store.schedule();
  const sent = [];
  const sender = { async send(target, text) { sent.push({ target, text }); } };
  await store.deliver(sender);
  assert.equal(sent.filter(x => x.target === '573001111111').length, 0);
  assert.equal(sent.filter(x => x.target === '573002222222').length, 1);
  store.accept({ ...s, version: 3, doctorId: 'medico2', payment: 'approved', form: 'completed' }); store.schedule();
  await store.deliver(sender);
  assert.equal(sent.filter(x => x.target === '573002222222').length, 1);
});
test('unknown/unavailable doctor never falls through to wrong recipient', t => {
  const { store, routes, s } = fixture(t);
  routes.defaultDoctorId = 'medico1';
  assert.equal(selectedDoctor({ ...s, doctorId: 'not-in-config' }, routes), null);
  assert.equal(selectedDoctor({ ...s, doctorId: 'PROVIDER_UNAVAILABLE' }, routes), null);
  store.accept({ ...s, doctorId: 'not-in-config' }); store.schedule();
  assert.equal(store.status().missingDoctor, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='reminder'").get().n, 0);
});
test('failed send persists with backoff; successful group is not retried', async t => {
  const { store, s } = fixture(t);
  store.accept(s); store.schedule();
  await store.deliver({ async send(target) { if (!target.endsWith('@g.us')) throw new Error('offline'); } });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='sent'").get().n, 1);
  const failed = store.db.prepare("SELECT * FROM jobs WHERE state='pending'").get();
  assert.equal(failed.attempts, 1);
  assert.ok(failed.due > Date.now());
  const sent = [];
  await store.deliver({ async send(target) { sent.push(target); } }, failed.due + 1);
  assert.deepEqual(sent, ['573001111111']);
});
test('encrypted state survives restart', t => {
  const { store, config, routes, s } = fixture(t);
  store.accept(s);
  const another = new Store(config, routes);
  assert.equal(another.get(s.id).doctorId, 'medico1');
  another.close();
  const payload = store.db.prepare('SELECT payload FROM appointments').get().payload;
  assert.ok(!payload.includes('medico1'));
  assert.ok(!readFileSync(join(config.directory, 'notifications.mock.sqlite')).includes(Buffer.from('573001111111')));
});
test('HTTP authentication, validation, duplicates and source separation', async t => {
  const { store, config, s } = fixture(t);
  const app = server(store, { ready: true });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const url = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(`${url}/status`)).status, 401);
  const post = body => fetch(`${url}/events/appointment`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body });
  assert.equal((await post('{bad')).status, 400);
  assert.equal((await post('x'.repeat(17000))).status, 413);
  assert.equal((await post(JSON.stringify(s))).status, 202);
  assert.equal((await (await post(JSON.stringify(s))).json()).accepted, false);
  config.source = 'sqlite';
  assert.equal((await post(JSON.stringify({ ...s, version: 2 }))).status, 409);
});
test('input rejects invalid dates and strips unwanted patient data', () => {
  const s = { id: 'test', version: 1, startsAt: '2027-02-28T10:00:00-05:00', patientName: 'Private', url: 'https://evil.invalid' };
  assert.equal(snapshot(s).patientName, 'Private');
  assert.equal(snapshot(s).url, undefined);
  assert.throws(() => snapshot({ ...s, startsAt: '2027-02-30T10:00:00-05:00' }));
  assert.throws(() => snapshot({ ...s, startsAt: '2027-02-28T10:00:00' }));
  assert.deepEqual(snapshot(snapshot(s)), snapshot(s));
});
test('provider fields require verified mapping; lookup uses Bearer and owned order id', async t => {
  const { config, routes } = fixture(t);
  const mapping = { doctorIdPath: 'medico._id', formPath: 'formulario.estado', formValues: { completed: ['LISTO'], pending: ['FALTA'] } };
  assert.deepEqual(providerFields({ medico: { _id: 'medico1' }, formulario: { estado: 'LISTO' } }, mapping), { doctorId: 'medico1', form: 'completed' });
  assert.deepEqual(providerFields({}, mapping), { doctorId: null, form: 'unknown' });
  assert.throws(() => providerFields({ medico: { _id: 'id' } }, { doctorIdPath: 'medico' }));
  routes.mediconecta = mapping;
  const client = mediconecta(config, routes, { MEDICONNECTA_LOOKUP: 'true', MEDICONNECTA_TOKEN: 'test-token' }, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    assert.equal(url, 'https://vip-mediconecta.app/api/ordenes/known-id');
    return { ok: true, async json() { return { success: true, data: { _id: 'known-id', medico: { _id: 'medico1' } } }; } };
  });
  assert.equal((await client.lookup('known-id')).doctorId, 'medico1');
  await assert.rejects(() => client.lookup('../unknown'));
  const wrong = mediconecta(config, routes, { MEDICONNECTA_LOOKUP: 'true', MEDICONNECTA_TOKEN: 'test' }, async () => ({ ok: true, async json() { return { success: true, data: { _id: 'other' } }; } }));
  await assert.rejects(() => wrong.lookup('known-id'));
});
test('real VIP SQLite schema: baseline, creation, payment and provider assignment changes', async t => {
  const { store, directory, s, cleanup } = fixture(t);
  const key = randomBytes(32), file = join(directory, 'source.sqlite');
  const source = new DatabaseSync(file);
  source.exec('CREATE TABLE requests(state TEXT,payment TEXT,data TEXT,updated INTEGER)');
  const seal = data => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const content = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
  };
  let physician = 'medico1', fail = false;
  const bridge = vipBridge(store, { VIP_DATABASE_PATH: file, VIP_DATA_ENCRYPTION_KEY: key.toString('hex') }, { async lookup() { if (fail) throw new Error(); return { doctorId: physician, form: 'completed' }; } });
  cleanup.push(() => { bridge.close(); source.close(); });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const rowData = seal({ externalId: s.id, attention: 'pending', patient: { date: tomorrow, time: '10:30' } });
  source.prepare('INSERT INTO requests VALUES(?,?,?,?)').run('confirmed', 'pending', rowData, 1);
  await bridge.poll();
  assert.equal(store.status().jobs.length, 0); // existing baseline is silent
  assert.equal(store.get(s.id).doctorId, 'medico1');
  physician = 'medico2';
  await bridge.poll();
  assert.equal(store.get(s.id).doctorId, 'medico2');
  source.prepare('UPDATE requests SET payment=?,updated=?').run('approved', 2);
  await bridge.poll();
  assert.equal(store.get(s.id).payment, 'approved');
  const n = store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  await bridge.poll();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, n);
  fail = true;
  assert.equal(await bridge.poll(), false);
  assert.equal(selectedDoctor(store.get(s.id), store.routes), null);
  source.prepare('INSERT INTO requests VALUES(?,?,?,?)').run('confirmed', 'pending', seal({ externalId: 'new-id', attention: 'pending', patient: { date: tomorrow, time: '14:00' } }), 3);
  await bridge.poll();
  assert.ok(store.db.prepare("SELECT id FROM jobs WHERE appointment='new-id' AND kind='created'").get());
  assert.equal(source.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 2);
});

test('MediConecta manual paid flag promotes payment without downgrading unpaid records', () => {
  const mapping = {
    doctorIdPath: 'medico',
    formPath: '',
    formValues: { completed: [], pending: [] },
    paymentPath: 'pagado',
    paymentApprovedValues: [true, 1, 'true', 'PAGADO', 'Pagado', 'pagado'],
  };
  assert.equal(providerFields({ medico: 'medico1', pagado: true }, mapping).payment, 'approved');
  assert.equal(providerFields({ medico: 'medico1', pagado: false }, mapping).payment, undefined);
});

test('doctor reminder uses the dedicated medical panel URL', t => {
  const { store, s } = fixture(t);
  store.config.doctorPanel = 'https://medico.vip-mediconecta.app/panel-medico';
  store.accept(s);
  store.schedule();
  const row = store.db.prepare("SELECT payload FROM jobs WHERE kind='reminder'").get();
  const payload = store.unseal(row.payload);
  assert.match(payload.text, /Panel médico: https:\/\/medico\.vip-mediconecta\.app\/panel-medico/);
  assert.doesNotMatch(payload.text, /\?_id=/);
});

test('MediConecta manual payment also accepts string 1', () => {
  const mapping = {
    doctorIdPath: 'medico',
    formPath: '',
    paymentPath: 'pagado',
    paymentApprovedValues: [true, 1, 'true', '1', 'PAGADO', 'Pagado', 'pagado'],
  };
  assert.equal(providerFields({ medico: 'medico1', pagado: '1' }, mapping).payment, 'approved');
});
