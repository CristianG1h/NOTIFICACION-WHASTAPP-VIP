import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const tables = {
  appointments: ['id', 'version', 'payload'],
  jobs: ['id', 'appointment', 'kind', 'payload', 'due', 'state', 'attempts'],
  reminders: ['id'], metadata: ['key', 'value'],
  offers: ['code', 'appointment', 'startsAt', 'payload'], inbound: ['id', 'received'],
};
export function exportState(store) {
  return Object.fromEntries(Object.keys(tables).map(table => [table, store.db.prepare(`SELECT * FROM ${table}`).all()]));
}
export function importState(store, state) {
  if (Object.keys(tables).some(table => !Array.isArray(state[table]))) throw new Error('Copia de estado incompleta');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, columns] of Object.entries(tables)) {
      store.db.exec(`DELETE FROM ${table}`);
      const insert = store.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of state[table]) insert.run(...columns.map(column => row[column]));
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Checkpoints are chunked; publishing the manifest is atomic. An interrupted write
// leaves the previous complete snapshot available. DATA_KEY protects all payloads.
export async function stateRepository(config, store, clientOverride, leaseOptions = {}) {
  if (!config.mongoUri && !clientOverride) return null;
  let client = clientOverride;
  if (!client) {
    const { MongoClient } = await import('mongodb');
    client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  }
  await client.connect();
  const collection = (config.mongoDatabase ? client.db(config.mongoDatabase) : client.db()).collection('vip_notification_state');
  const scope = `${config.baileysSessionId}:${config.mode}`, owner = randomUUID();
  const leaseId = `${scope}:lease`;
  const leaseMs = leaseOptions.durationMs ?? 90000;
  const renewEveryMs = leaseOptions.renewEveryMs ?? 20000;
  let lost = true, leaseExpires = 0, leaseError = null;
  let digest, timer, chain = Promise.resolve(), renewal = Promise.resolve();

  async function renew() {
    const now = Date.now();
    try {
      const r = await collection.updateOne(
        { _id: leaseId, $or: [{ owner }, { expires: { $lt: now } }] },
        { $set: { scope, owner, expires: now + leaseMs } },
        { upsert: true }
      );
      if (!r.matchedCount && !r.upsertedCount) throw new Error('lease ocupado');
      const recovered = lost;
      leaseExpires = now + leaseMs;
      lost = false;
      leaseError = null;
      if (recovered) console.log('[MongoDB] Bloqueo recuperado. Se reanudan los avisos pendientes.');
    } catch (error) {
      lost = true;
      leaseError = error?.code === 11000 ? 'Bloqueo ocupado por otra instancia' : 'No se pudo renovar el bloqueo';
      throw new Error(`${leaseError}. Se pausan los envíos hasta recuperar el bloqueo de MongoDB.`);
    }
  }

  async function acquire() {
    const waitMs = leaseOptions.waitMs ?? Math.max(10000, Number(process.env.MONGODB_LEASE_WAIT_MS || 180000));
    const deadline = Date.now() + waitMs;
    let lastNotice = 0;

    while (true) {
      const now = Date.now();
      try {
        const r = await collection.updateOne(
          { _id: leaseId, $or: [{ owner }, { expires: { $lt: now } }] },
          { $set: { scope, owner, expires: now + leaseMs } },
          { upsert: true }
        );
        if (r.matchedCount || r.upsertedCount) {
          leaseExpires = now + leaseMs;
          console.log('[MongoDB] Bloqueo adquirido. Este despliegue queda como bot activo.');
          return;
        }
      } catch (error) {
        // Cuando el _id ya existe y pertenece al deploy anterior, MongoDB devuelve
        // normalmente E11000 por el upsert. Eso es esperado durante un deploy
        // zero-downtime de Render: el proceso anterior sigue activo unos segundos.
        if (error?.code !== 11000) {
          await client.close().catch(() => {});
          throw new Error(`No se pudo adquirir el bloqueo MongoDB: ${error?.message || 'error desconocido'}`);
        }
      }

      if (Date.now() >= deadline) {
        await client.close().catch(() => {});
        throw new Error('El bloqueo MongoDB siguió ocupado demasiado tiempo. Verifica que no exista otro servicio usando el mismo BAILEYS_SESSION_ID.');
      }

      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        console.log('[MongoDB] El deploy anterior todavía tiene el bloqueo. Esperando liberación sin iniciar un segundo bot...');
      }
      await sleep(3000);
    }
  }

  await acquire();
  lost = false;
  // No solapar renovaciones si MongoDB está lento. Una falla temporal no deja
  // el bot bloqueado para siempre: el siguiente éxito reactiva el mismo lease.
  timer = setInterval(() => {
    renewal = renewal.catch(() => {}).then(renew);
    void renewal.catch(error => console.error(error.message));
  }, renewEveryMs);
  timer.unref();

  const assertActive = () => {
    if (lost || Date.now() >= leaseExpires) throw new Error('Persistencia/bloqueo no disponible. Se pausaron los avisos hasta recuperar MongoDB.');
  };

  return {
    assertActive,
    leaseStatus() {
      return { healthy: !lost && Date.now() < leaseExpires, error: leaseError };
    },
    async restore() {
      const manifest = await collection.findOne({ _id: `${scope}:manifest` });
      if (!manifest) return;
      const chunks = await collection.find({ scope, generation: manifest.generation, index: { $exists: true } }).toArray();
      chunks.sort((a, b) => a.index - b.index);
      if (chunks.length !== manifest.count) throw new Error('Copia de estado incompleta en MongoDB');
      const packed = store.unseal(chunks.map(c => c.payload).join(''));
      const raw = gunzipSync(Buffer.from(packed.data, 'base64')).toString('utf8');
      if (createHash('sha256').update(raw).digest('hex') !== manifest.digest) throw new Error('Copia de estado corrupta');
      importState(store, JSON.parse(raw)); digest = manifest.digest;
    },
    save() {
      const operation = chain.catch(() => {}).then(async () => {
        assertActive();
        const raw = JSON.stringify(exportState(store)), next = createHash('sha256').update(raw).digest('hex');
        if (next === digest) return;
        const payload = store.seal({ data: gzipSync(raw).toString('base64') }), generation = randomUUID();
        const chunks = [];
        for (let offset = 0; offset < payload.length; offset += 500000) chunks.push(payload.slice(offset, offset + 500000));
        await collection.insertMany(chunks.map((payload, index) => ({ _id: `${scope}:${generation}:${index}`, scope, generation, index, payload })));
        assertActive();
        await collection.updateOne({ _id: `${scope}:manifest` }, { $set: { scope, generation, count: chunks.length, digest: next } }, { upsert: true });
        digest = next;
        await collection.deleteMany({ scope, generation: { $exists: true, $ne: generation }, _id: { $ne: `${scope}:manifest` } });
      });
      chain = operation;
      return operation;
    },
    async close() {
      clearInterval(timer);
      await renewal.catch(() => {});
      await chain.catch(() => {});
      try { await collection.deleteOne({ _id: leaseId, owner }); }
      finally { await client.close(); }
    },
  };
}
