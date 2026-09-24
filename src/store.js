import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { snapshot, selectedDoctor, message, InputError } from './domain.js';

export class Store {
  constructor(config, routes) {
    this.config = config; this.routes = routes;
    mkdirSync(config.directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(config.directory, `notifications.${config.mode}.sqlite`));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, appointment TEXT NOT NULL, kind TEXT NOT NULL,
        payload TEXT NOT NULL, due INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,due);
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  seal(data) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.config.key, iv);
    const payload = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64');
  }
  unseal(data) {
    const bytes = Buffer.from(data, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.config.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  }
  get(id) {
    const row = this.db.prepare('SELECT payload FROM appointments WHERE id=?').get(id);
    return row ? this.unseal(row.payload) : null;
  }
  enqueue(id, s, kind, target, due) {
    this.db.prepare('INSERT OR IGNORE INTO jobs(id,appointment,kind,payload,due) VALUES(?,?,?,?,?)')
      .run(id, s.id, kind, this.seal({ target, text: message(s, kind, this.config.doctorPanel || 'https://medico.vip-mediconecta.app/panel-medico'), startsAt: s.startsAt }), due);
  }
  accept(input, now = Date.now(), baseline = false) {
    const s = snapshot(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get(s.id);
      if (previous && s.version <= previous.version) {
        if (s.version === previous.version && JSON.stringify(s) !== JSON.stringify(previous)) throw new InputError('La versión ya existe con contenido distinto', 409);
        this.db.exec('COMMIT'); return { accepted: false, reason: 'duplicate_or_old' };
      }
      const changed = !previous || ['startsAt', 'doctorId', 'status', 'payment', 'form', 'patientName'].some(k => s[k] !== previous[k]);
      this.db.prepare('INSERT INTO appointments VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload')
        .run(s.id, s.version, this.seal(s));
      if (changed) {
        this.db.prepare("UPDATE jobs SET state='cancelled' WHERE appointment=? AND kind IN ('reminder','test_reminder') AND state IN ('pending','failed')").run(s.id);
        if (!baseline && this.routes.controlGroupId) this.enqueue(`control:${s.id}:${s.version}`, s, previous ? 'updated' : 'created', this.routes.controlGroupId, now);
      }
      this.db.exec('COMMIT');
      return { accepted: true, doctorConfigured: !!selectedDoctor(s, this.routes), groupConfigured: !!this.routes.controlGroupId };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  schedule(now = Date.now()) {
    for (const row of this.db.prepare('SELECT payload FROM appointments').all()) {
      const s = this.unseal(row.payload), starts = Date.parse(s.startsAt), doctor = selectedDoctor(s, this.routes);
      if (s.status !== 'confirmed' || !doctor || starts <= now || starts - now > this.config.reminderMinutes * 60000) continue;
      const id = createHash('sha256').update(`${s.id}|${s.startsAt}|${doctor}`).digest('hex');
      if (this.db.prepare('SELECT id FROM reminders WHERE id=?').get(id)) continue;
      // An update can cancel a queued reminder. Rebuild it with the latest payment/form.
      this.db.prepare("DELETE FROM jobs WHERE id=? AND state='cancelled'").run(id);
      this.enqueue(id, s, 'reminder', doctor, now);
    }
  }
  upcoming(now = Date.now()) {
    return this.db.prepare('SELECT payload FROM appointments').all().map(r => this.unseal(r.payload))
      .filter(s => s.status === 'confirmed' && Date.parse(s.startsAt) > now)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .map(s => ({ id: s.id, patientName: s.patientName || 'Nombre no disponible', startsAt: s.startsAt, doctorConfigured: !!selectedDoctor(s, this.routes) }));
  }
  testDoctor(id, requestId, now = Date.now()) {
    if (typeof requestId !== 'string' || !/^[a-f\d-]{36}$/i.test(requestId)) throw new InputError('Identificador de prueba inválido');
    const s = typeof id === 'string' ? this.get(id) : null;
    if (!s || s.status !== 'confirmed' || Date.parse(s.startsAt) <= now) throw new InputError('Elige una cita confirmada y futura', 409);
    const doctor = selectedDoctor(s, this.routes);
    if (!doctor) throw new InputError('Esta cita no tiene médico asignado con WhatsApp configurado', 409);
    this.enqueue(`test:${requestId}`, s, 'test_reminder', doctor, now);
    return { queued: true, message: 'Prueba en cola. El recordatorio automático se conserva.' };
  }
  async deliver(sender, now = Date.now()) {
    const jobs = this.db.prepare("SELECT * FROM jobs WHERE state='pending' AND due<=? ORDER BY due LIMIT 10").all(now);
    for (const job of jobs) {
      const payload = this.unseal(job.payload);
      if (['reminder', 'test_reminder'].includes(job.kind)) {
        const current = this.get(job.appointment);
        if (!current || current.status !== 'confirmed' || current.startsAt !== payload.startsAt || Date.parse(current.startsAt) <= Date.now() || selectedDoctor(current, this.routes) !== payload.target) {
          this.db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(job.id); continue;
        }
      }
      try {
        await sender.send(payload.target, payload.text);
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare("UPDATE jobs SET state='sent' WHERE id=?").run(job.id);
          if (job.kind === 'reminder') this.db.prepare('INSERT OR IGNORE INTO reminders VALUES(?)').run(job.id);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      } catch {
        const attempts = job.attempts + 1;
        this.db.prepare('UPDATE jobs SET attempts=?,due=?,state=? WHERE id=?')
          .run(attempts, now + Math.min(3600000, 30000 * 2 ** attempts), attempts >= 8 ? 'failed' : 'pending', job.id);
        console.error(JSON.stringify({ event: 'delivery_failed', attempts }));
      }
    }
  }
  status() {
    const counts = this.db.prepare('SELECT state,COUNT(*) AS count FROM jobs GROUP BY state').all();
    const records = this.db.prepare('SELECT payload FROM appointments').all().map(r => this.unseal(r.payload));
    return { jobs: counts, appointments: records.length, missingDoctor: records.filter(s => s.status === 'confirmed' && !selectedDoctor(s, this.routes)).length };
  }
  close() { this.db.close(); }
}
