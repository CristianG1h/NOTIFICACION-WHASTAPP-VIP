import { randomUUID } from 'node:crypto';

export const ADMIN_PHONES = ['573102210461', '573212340504'];

export function normalizePhone(value) {
  if (typeof value !== 'string' || !/^[+\d\s()-]+$/.test(value)) throw new Error('Escribe un celular colombiano: 57 + 10 dígitos.');
  let phone = value.replace(/\D/g, '');
  if (/^3\d{9}$/.test(phone)) phone = `57${phone}`;
  if (!/^573\d{9}$/.test(phone)) throw new Error('Número inválido. Ejemplo: 573001234567 (también acepto 3001234567).');
  return phone;
}

export class Doctors {
  constructor(store, repository = null) {
    this.store = store;
    this.repository = repository;
    const saved = store.db.prepare("SELECT value FROM metadata WHERE key='doctor_directory'").get();
    this.state = saved ? store.unseal(saved.value) : {
      managed: false,
      doctors: Object.entries(store.routes.doctors).map(([id, phone]) => ({ id, phone, name: store.routes.doctorNames?.[id] || id })),
    };
    this.apply();
  }
  async initialize() {
    const remote = await this.repository?.load();
    if (remote) { this.state = remote; this.cache(); this.apply(); }
  }
  cache() {
    this.store.db.prepare("INSERT INTO metadata VALUES('doctor_directory',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(this.store.seal(this.state));
  }
  apply() {
    const routes = this.store.routes;
    routes.doctors = Object.fromEntries(this.state.doctors.map(d => [d.id, d.phone]));
    routes.doctorNames = Object.fromEntries(this.state.doctors.map(d => [d.id, d.name]));
    routes.broadcastDoctors = this.state.managed;
  }
  list() { return this.state.doctors.map(d => ({ ...d })); }
  async save(doctors) {
    const state = { managed: true, doctors };
    // Save remotely before acknowledging a change on hosts with ephemeral disks.
    await this.repository?.save(state);
    this.state = state; this.cache(); this.apply();
  }
  async upsert(id, name, input) {
    name = String(name).replace(/[\r\n\t*_~`]/g, ' ').trim();
    if (!name || name.length > 80) throw new Error('El nombre debe tener entre 1 y 80 caracteres.');
    const phone = normalizePhone(input);
    const doctors = this.list();
    if (doctors.some(d => d.phone === phone && d.id !== id)) throw new Error('Ese número ya pertenece a un médico guardado.');
    const index = id ? doctors.findIndex(d => d.id === id) : -1;
    if (id && index < 0) throw new Error('El médico ya no existe. Escribe MEDICO para actualizar el menú.');
    if (!id && doctors.length >= 100) throw new Error('Límite de 100 médicos alcanzado.');
    const doctor = { id: id || `doctor_${randomUUID().replaceAll('-', '')}`, name, phone };
    if (index < 0) doctors.push(doctor); else doctors[index] = doctor;
    await this.save(doctors);
    return doctor;
  }
  async remove(id) {
    await this.save(this.list().filter(d => d.id !== id));
  }
}

export async function doctorRepository(config, store) {
  if (!config.mongoUri) return null;
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const collection = (config.mongoDatabase ? client.db(config.mongoDatabase) : client.db()).collection('vip_doctor_directory');
  const _id = config.baileysSessionId;
  return {
    async load() { const record = await collection.findOne({ _id }); return record ? store.unseal(record.payload) : null; },
    async save(state) { await collection.updateOne({ _id }, { $set: { payload: store.seal(state), updatedAt: new Date() } }, { upsert: true }); },
    async close() { await client.close(); },
  };
}
