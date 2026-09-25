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
export async function stateRepository(config, store, clientOverride) {
  if (!config.mongoUri && !clientOverride) return null;
  const { MongoClient } = await import('mongodb');
  const client = clientOverride || new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const collection = (config.mongoDatabase ? client.db(config.mongoDatabase) : client.db()).collection('vip_notification_state');
  const scope = `${config.baileysSessionId}:${config.mode}`, owner = randomUUID();
  const leaseId = `${scope}:lease`;
  let lost = false, digest, timer, chain = Promise.resolve();

  async function renew() {
    const now = Date.now();
    try {
      const r = await collection.updateOne(
        { _id: leaseId, $or: [{ owner }, { expires: { $lt: now } }] },
        { $set: { scope, owner, expires: now + 90000 } },
        { upsert: true }
      );
      if (!r.matchedCount && !r.upsertedCount) throw new Error('lease ocupado');
    } catch {
      lost = true;
      throw new Error('Otro bot está activo o no se pudo renovar el bloqueo MongoDB. No se enviarán avisos.');
    }
  }

  async function acquire() {
    const waitMs = Math.max(10000, Number(process.env.MONGODB_LEASE_WAIT_MS || 180000));
    const deadline = Date.now() + waitMs;
    let lastNotice = 0;

    while (true) {
      const now = Date.now();
      try {
        const r = await collection.updateOne(
          { _id: leaseId, $or: [{ owner }, { expires: { $lt: now } }] },
          { $set: { scope, owner, expires: now + 90000 } },
          { upsert: true }
        );
        if (r.matchedCount || r.upsertedCount) {
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
  timer = setInterval(() => { void renew().catch(error => console.error(error.message)); }, 20000);
  timer.unref();

  const assertActive = () => {
    if (lost) throw new Error('Persistencia/bloqueo no disponible. Reinicia cuando MongoDB esté disponible.');
  };

  return {
    assertActive,
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
      await chain.catch(() => {});
      try { await collection.deleteOne({ _id: leaseId, owner }); }
      finally { await client.close(); }
    },
  };
}
