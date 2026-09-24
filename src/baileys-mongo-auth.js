import { MongoClient } from 'mongodb';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

const DEFAULT_COLLECTION = 'baileys_auth';

function encode(value) {
  return JSON.stringify(value, BufferJSON.replacer);
}

function decode(value) {
  if (typeof value !== 'string' || !value) return null;
  return JSON.parse(value, BufferJSON.reviver);
}

function documentId(sessionId, key) {
  return `${sessionId}::${key}`;
}

/**
 * Persistent Baileys auth state backed by MongoDB.
 *
 * Each Baileys credential/key is stored as an independent document. This mirrors
 * useMultiFileAuthState while avoiding Render's ephemeral filesystem. Payloads are
 * JSON strings serialized with Baileys BufferJSON, so Buffers/Uint8Arrays survive
 * a restart without BSON type conversion surprises.
 */
export async function useMongoAuthState({
  uri,
  sessionId,
  databaseName = '',
  collectionName = DEFAULT_COLLECTION,
  clientFactory,
}) {
  if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//.test(uri)) {
    throw new Error('MONGODB_URI inválida');
  }
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) {
    throw new Error('BAILEYS_SESSION_ID inválido');
  }

  const client = clientFactory
    ? await clientFactory(uri)
    : new MongoClient(uri, {
        maxPoolSize: 4,
        minPoolSize: 0,
        maxIdleTimeMS: 60_000,
        serverSelectionTimeoutMS: 15_000,
        connectTimeoutMS: 15_000,
      });

  if (typeof client.connect === 'function') await client.connect();

  const db = databaseName ? client.db(databaseName) : client.db();
  const collection = db.collection(collectionName);
  await collection.createIndex({ sessionId: 1 }, { name: 'sessionId_idx' });

  const readData = async key => {
    const doc = await collection.findOne({ _id: documentId(sessionId, key) });
    return doc?.payload ? decode(doc.payload) : null;
  };

  const writeData = async (value, key) => {
    const now = new Date();
    await collection.updateOne(
      { _id: documentId(sessionId, key) },
      {
        $set: {
          sessionId,
          key,
          payload: encode(value),
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  };

  const removeData = key => collection.deleteOne({ _id: documentId(sessionId, key) });

  const creds = (await readData('creds')) || initAuthCreds();

  const state = {
    creds,
    keys: {
      async get(type, ids) {
        const wanted = ids.map(id => ({ id, mongoId: documentId(sessionId, `${type}-${id}`) }));
        const docs = wanted.length
          ? await collection.find({ _id: { $in: wanted.map(item => item.mongoId) } }).toArray()
          : [];
        const byId = new Map(docs.map(doc => [doc._id, doc]));
        const data = {};
        for (const item of wanted) {
          const doc = byId.get(item.mongoId);
          let value = doc?.payload ? decode(doc.payload) : null;
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          data[item.id] = value;
        }
        return data;
      },

      async set(data) {
        const now = new Date();
        const operations = [];
        for (const [category, values] of Object.entries(data || {})) {
          for (const [id, value] of Object.entries(values || {})) {
            const key = `${category}-${id}`;
            const _id = documentId(sessionId, key);
            if (value) {
              operations.push({
                updateOne: {
                  filter: { _id },
                  update: {
                    $set: {
                      sessionId,
                      key,
                      payload: encode(value),
                      updatedAt: now,
                    },
                    $setOnInsert: { createdAt: now },
                  },
                  upsert: true,
                },
              });
            } else {
              operations.push({ deleteOne: { filter: { _id } } });
            }
          }
        }
        if (operations.length) await collection.bulkWrite(operations, { ordered: false });
      },
    },
  };

  return {
    state,
    storage: 'mongodb',
    async saveCreds() {
      await writeData(state.creds, 'creds');
    },
    async clear() {
      await collection.deleteMany({ sessionId });
    },
    async close() {
      if (typeof client.close === 'function') await client.close();
    },
    async status() {
      const documents = await collection.countDocuments({ sessionId });
      return { storage: 'mongodb', sessionId, documents };
    },
    // Exposed only for focused tests/diagnostics; application code should use state.
    _internals: { readData, writeData, removeData },
  };
}
