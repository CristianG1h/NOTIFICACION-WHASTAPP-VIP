import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Doctors, normalizePhone, ADMIN_PHONES } from '../src/doctors.js';
import { Conversation, incomingMessage } from '../src/conversation.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'vip-conversation-'));
  const store = new Store({ directory, mode: 'mock', reminderMinutes: 15, key: randomBytes(32) }, {
    controlGroupId: '123@g.us', doctors: {}, assignments: {}, defaultDoctorId: '',
  });
  const doctors = new Doctors(store), chat = new Conversation(store, doctors), now = Date.now();
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  const s = { id: 'order1', version: 1, patientName: 'Ana', startsAt: new Date(now + 600000).toISOString(), status: 'confirmed' };
  return { store, doctors, chat, now, s };
}

test('Colombian number normalization and malformed input', () => {
  for (const input of ['3001234567', '+57 300 123 4567', '57 (300) 123-4567']) assert.equal(normalizePhone(input), '573001234567');
  for (const input of ['123', '573001234567 extra', '3001234567,3011234567', '5730012345678']) assert.throws(() => normalizePhone(input));
});

test('only both administrators can add, edit and delete; stable IDs and persistence', async t => {
  const { chat, doctors, store } = fixture(t);
  assert.equal(await chat.text('573009999999', 'MEDICO'), null);
  for (const [i, admin] of ADMIN_PHONES.entries()) {
    assert.match(await chat.text(admin, 'MÉDICOS'), /Agregar médico/);
    await chat.text(admin, `${i + 1}`);
    await chat.text(admin, i ? 'Luisa' : 'Paulo');
    assert.match(await chat.text(admin, i ? '3011234567' : '3001234567'), /Guardado/);
  }
  assert.equal(doctors.list().length, 2);
  const id = doctors.list()[0].id;
  const admin = ADMIN_PHONES[0];
  await chat.text(admin, 'MEDICO'); await chat.text(admin, '1'); await chat.text(admin, '1');
  await chat.text(admin, 'Paulo García'); await chat.text(admin, '3001234568');
  assert.equal(doctors.list()[0].id, id);
  assert.equal(new Doctors(store).list()[0].name, 'Paulo García');
  assert.doesNotMatch(await chat.text('573001234568', 'MEDICO'), /Agregar médico/);
  await chat.text(admin, 'MEDICO'); await chat.text(admin, '2'); await chat.text(admin, '2');
  assert.equal(doctors.list().length, 2);
  await chat.text(admin, 'ELIMINAR'); assert.equal(doctors.list().length, 1);
});

test('duplicate numbers and remote save failures never acknowledge a mutation', async t => {
  const { doctors } = fixture(t);
  await doctors.upsert(null, 'Paulo', '3001234567');
  await assert.rejects(() => doctors.upsert(null, 'Otro', '3001234567'), /ya pertenece/);
  doctors.repository = { async save() { throw new Error('offline'); } };
  await assert.rejects(() => doctors.upsert(null, 'Luisa', '3011234567'));
  assert.equal(doctors.list().length, 1);
});

test('two recipients; first confirmation wins; exact-time reminder goes only to winner with fresh data', async t => {
  const { store, doctors, chat, s, now } = fixture(t);
  await doctors.upsert(null, 'Paulo', '3001234567'); await doctors.upsert(null, 'Luisa', '3011234567');
  store.accept(s, now); store.schedule(now);
  const sent = [], sender = { async send(target, text) { sent.push({ target, text }); } };
  await store.deliver(sender, now + 1000);
  assert.equal(sent.length, 3);
  const code = store.offer(store.get(s.id)).code;
  assert.match(await chat.text('573001234567', '1'), /confirmaste/);
  assert.match(await chat.text('573011234567', `1 ${code}`), /ya fue confirmada por Paulo/);
  await store.deliver(sender, now + 1000);
  assert.equal(sent.filter(x => x.target === '123@g.us').length, 1);
  assert.match(sent.at(-1).text, /Hola, Luisa[\s\S]*Paulo confirmó/);
  store.accept({ ...s, version: 2, payment: 'approved', form: 'completed' }, now);
  store.schedule(now + 600000); await store.deliver(sender, now + 600000);
  assert.equal(sent.filter(x => x.text.includes('¡Es hora')).length, 1);
  assert.equal(sent.at(-1).target, '573001234567');
  assert.match(sent.at(-1).text, /Pago: Pagado/);
  store.schedule(now + 601000); await store.deliver(sender, now + 601000);
  assert.equal(sent.filter(x => x.text.includes('¡Es hora')).length, 1);
});

test('decline is per recipient; cancelled/rescheduled offers cannot be confirmed', async t => {
  const { store, doctors, s, now } = fixture(t);
  await doctors.upsert(null, 'Paulo', '3001234567'); await doctors.upsert(null, 'Luisa', '3011234567');
  store.accept(s); store.schedule(); await store.deliver({ async send() {} });
  const code = store.offer(store.get(s.id)).code;
  assert.match(store.respond('573001234567', '2', code), /no puedes atender/);
  assert.equal(store.pendingOffers('573001234567').length, 0);
  store.accept({ ...s, version: 2, startsAt: new Date(now + 3600000).toISOString() });
  assert.match(store.respond('573011234567', '1', code), /No hay/);
});

test('multiple appointments require a code; deleted doctors lose permissions immediately', async t => {
  const { store, doctors, chat, s } = fixture(t);
  const doctor = await doctors.upsert(null, 'Paulo', '3001234567');
  store.accept(s); store.accept({ ...s, id: 'order2' }); store.schedule();
  await store.deliver({ async send() {} });
  assert.match(await chat.text(doctor.phone, '1'), /varias citas/);
  assert.equal(store.offer(store.get(s.id)).winner, null);
  await doctors.remove(doctor.id);
  assert.equal(await chat.text(doctor.phone, '1'), null);
});

test('group only gets creation and time changes; unhealthy source still permits admin replies', async t => {
  const { store, doctors, chat, s } = fixture(t);
  await doctors.upsert(null, 'Paulo', '3001234567');
  store.accept(s); store.schedule();
  store.accept({ ...s, version: 2, payment: 'approved', form: 'completed' });
  store.schedule();
  await chat.receive({ id: 'inbound1', phone: ADMIN_PHONES[0], text: 'MEDICO' });
  await chat.receive({ id: 'inbound1', phone: ADMIN_PHONES[0], text: '1' });
  const sent = [];
  await store.deliver({ async send(target) { sent.push(target); } }, Date.now(), { sourceHealthy: false });
  assert.deepEqual(sent, ['123@g.us', ADMIN_PHONES[0]]);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='reply'").get().n, 1);
  store.accept({ ...s, version: 3, startsAt: new Date(Date.parse(s.startsAt) + 3600000).toISOString() });
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='updated'").get().n, 1);
});

test('transport identity handles LID, rejects groups, own messages and unresolved identity', async () => {
  const m = { key: { id: 'x', remoteJid: '123@lid', remoteJidAlt: `${ADMIN_PHONES[0]}@s.whatsapp.net` }, message: { conversation: 'MEDICO' } };
  assert.equal((await incomingMessage(m, {})).phone, ADMIN_PHONES[0]);
  assert.equal(await incomingMessage({ ...m, key: { ...m.key, fromMe: true } }, {}), null);
  assert.equal(await incomingMessage({ ...m, key: { ...m.key, remoteJid: '123@g.us' } }, {}), null);
  assert.equal(await incomingMessage({ ...m, key: { id: 'x', remoteJid: '123@lid' } }, {}), null);
});
