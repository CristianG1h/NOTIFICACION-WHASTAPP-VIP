import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { exportState, importState, stateRepository } from '../src/state-repository.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'vip-state-'));
  const config = { directory, mode: 'mock', key: randomBytes(32), reminderMinutes: 15, baileysSessionId: 'test' };
  const store = new Store(config, { doctors: { p: '573001234567' }, defaultDoctorId: 'p', assignments: {} });
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  return { store, config };
}

function memoryMongo() {
  const docs = new Map();
  let failInsert = false;
  const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(f => matches(doc, f));
    if (value && typeof value === 'object') return Object.entries(value).every(([op, val]) =>
      op === '$lt' ? doc[key] < val : op === '$ne' ? doc[key] !== val : op === '$exists' ? (key in doc) === val : false);
    return doc[key] === value;
  });
  const collection = {
    async findOne(filter) { return [...docs.values()].find(d => matches(d, filter)); },
    find(filter) { return { async toArray() { return [...docs.values()].filter(d => matches(d, filter)); } }; },
    async updateOne(filter, change) {
      const existing = await this.findOne(filter);
      if (!existing && docs.has(filter._id)) throw new Error('duplicate key');
      docs.set(filter._id, { ...(existing || { _id: filter._id }), ...change.$set });
      return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
    },
    async insertMany(rows) { if (failInsert) throw new Error('offline'); for (const row of rows) docs.set(row._id, row); },
    async deleteMany(filter) { for (const doc of [...docs.values()]) if (matches(doc, filter)) docs.delete(doc._id); },
    async deleteOne(filter) { const doc = await this.findOne(filter); if (doc) docs.delete(doc._id); },
  };
  return { async connect() {}, async close() {}, db() { return { collection: () => collection }; }, docs, failWrites() { failInsert = true; } };
}

test('checkpoint restores appointments, sent markers, claims and message dedup after local loss', async t => {
  const { store, config } = fixture(t), mongo = memoryMongo();
  store.accept({ id: 'cita', version: 1, startsAt: new Date(Date.now() + 600000).toISOString() });
  store.schedule(); await store.deliver({ async send() {} });
  store.respond('573001234567', '1');
  const repository = await stateRepository(config, store, mongo);
  try {
    await repository.save();
    const expected = exportState(store);
    store.db.exec('DELETE FROM offers; DELETE FROM reminders; DELETE FROM appointments');
    await repository.restore();
    assert.deepEqual(exportState(store), expected);
    assert.equal(store.offer(store.get('cita')).winner.phone, '573001234567');
    store.schedule(); let sends = 0; await store.deliver({ async send() { sends++; } });
    assert.equal(sends, 0);
    assert.ok(!JSON.stringify([...mongo.docs.values()]).includes('573001234567'));
  } finally { await repository.close(); }
});

test('lease excludes another worker; failed snapshot retains the previous manifest', async t => {
  const { store, config } = fixture(t), mongo = memoryMongo();
  const repository = await stateRepository(config, store, mongo);
  try {
    await repository.save();
    await assert.rejects(() => stateRepository(config, store, mongo), /Otro bot/);
    const old = mongo.docs.get('test:mock:manifest').generation;
    store.accept({ id: 'new', version: 1, startsAt: new Date(Date.now() + 600000).toISOString() });
    mongo.failWrites();
    await assert.rejects(() => repository.save());
    assert.equal(mongo.docs.get('test:mock:manifest').generation, old);
  } finally { await repository.close(); }
});

test('invalid restore rolls back local data; checkpoint failure does not retry sent jobs', async t => {
  const { store } = fixture(t);
  const initial = exportState(store);
  assert.throws(() => importState(store, { ...initial, appointments: [{ id: 'bad' }] }));
  assert.deepEqual(exportState(store), initial);
  store.accept({ id: 'cita', version: 1, startsAt: new Date(Date.now() + 600000).toISOString() });
  store.schedule(); store.persist = async () => { throw new Error('offline'); };
  await assert.rejects(() => store.deliver({ async send() {} }));
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='sent'").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='pending'").get().n, 0);
});
