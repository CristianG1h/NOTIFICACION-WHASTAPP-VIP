import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { snapshot, selectedDoctors, message, InputError } from './domain.js';

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
      CREATE TABLE IF NOT EXISTS offers(code TEXT PRIMARY KEY, appointment TEXT NOT NULL, startsAt TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(appointment,startsAt));
      CREATE TABLE IF NOT EXISTS inbound(id TEXT PRIMARY KEY, received INTEGER NOT NULL);
    `);
    // Drop obsolete queued group updates on upgrade; they include payment/form noise.
    if (!this.db.prepare("SELECT key FROM metadata WHERE key='selective_notifications_v2'").get()) {
      this.db.prepare("UPDATE jobs SET state='cancelled' WHERE kind='updated' AND state IN ('pending','failed')").run();
      this.db.prepare("INSERT INTO metadata VALUES('selective_notifications_v2','done')").run();
    }
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
  enqueue(id, s, kind, target, due, extra = {}) {
    this.db.prepare('INSERT OR IGNORE INTO jobs(id,appointment,kind,payload,due) VALUES(?,?,?,?,?)')
      .run(id, s.id, kind, this.seal({ target, text: message(s, kind, this.config.doctorPanel || 'https://medico.vip-mediconecta.app/panel-medico'), startsAt: s.startsAt, ...extra }), due);
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
        this.db.prepare("UPDATE jobs SET state='cancelled' WHERE appointment=? AND kind IN ('reminder','exact','test_reminder') AND state IN ('pending','failed')").run(s.id);
        const groupChanged = !previous || previous.startsAt !== s.startsAt;
        if (groupChanged && !baseline && this.routes.controlGroupId) this.enqueue(`control:${s.id}:${s.version}`, s, previous ? 'updated' : 'created', this.routes.controlGroupId, now);
      }
      this.db.exec('COMMIT');
      return { accepted: true, doctorConfigured: selectedDoctors(s, this.routes).length > 0, groupConfigured: !!this.routes.controlGroupId };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  schedule(now = Date.now()) {
    for (const row of this.db.prepare('SELECT payload FROM appointments').all()) {
      const s = this.unseal(row.payload), starts = Date.parse(s.startsAt);
      if (s.status !== 'confirmed' || now - starts > 120000 || starts - now > this.config.reminderMinutes * 60000) continue;
      const kind = starts > now ? 'reminder' : 'exact';
      const doctors = selectedDoctors(s, this.routes);
      if (!doctors.length) continue;
      const offer = this.offer(s);
      for (const doctor of doctors) {
        if (offer.declined.includes(doctor) || (offer.winner && offer.winner.phone !== doctor)) continue;
        // Preserve legacy reminder IDs to avoid replaying on upgrade.
        const id = createHash('sha256').update(`${s.id}|${s.startsAt}|${doctor}${kind === 'exact' ? '|exact' : ''}`).digest('hex');
        if (this.db.prepare('SELECT id FROM reminders WHERE id=?').get(id)) continue;
        this.db.prepare("DELETE FROM jobs WHERE id=? AND state='cancelled'").run(id);
        this.enqueue(id, s, kind, doctor, now, { code: offer.code });
      }
    }
  }
  offer(s) {
    const row = this.db.prepare('SELECT code,payload FROM offers WHERE appointment=? AND startsAt=?').get(s.id, s.startsAt);
    if (row) return { ...this.unseal(row.payload), code: row.code };
    const code = randomBytes(6).toString('hex').toUpperCase();
    const value = { winner: null, declined: [], notified: [] };
    this.db.prepare('INSERT INTO offers VALUES(?,?,?,?)').run(code, s.id, s.startsAt, this.seal(value));
    return { ...value, code };
  }
  saveOffer(offer) {
    this.db.prepare('UPDATE offers SET payload=? WHERE code=?').run(this.seal(offer), offer.code);
  }
  doctorName(phone) {
    const id = Object.keys(this.routes.doctors).find(id => this.routes.doctors[id] === phone);
    return this.routes.doctorNames?.[id] || id || 'Médico';
  }
  pendingOffers(phone, now = Date.now()) {
    return this.db.prepare('SELECT * FROM offers').all().flatMap(row => {
      const s = this.get(row.appointment), offer = this.unseal(row.payload);
      if (!s || s.startsAt !== row.startsAt || s.status !== 'confirmed' || now > Date.parse(s.startsAt) + 120000 ||
          !offer.notified.includes(phone) || !selectedDoctors(s, this.routes).includes(phone) || offer.declined.includes(phone)) return [];
      return [{ ...offer, code: row.code, appointment: s }];
    });
  }
  respond(phone, decision, code, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const offers = this.pendingOffers(phone, now);
      const wanted = code ? offers.filter(o => o.code === code.toUpperCase()) : offers.filter(o => !o.winner);
      if (!wanted.length) {
        this.db.exec('COMMIT');
        return 'No hay una solicitud pendiente para esa respuesta. Si ya fue confirmada, revisa el aviso recibido.';
      }
      if (wanted.length > 1) {
        this.db.exec('COMMIT');
        return `Tienes varias citas. Responde ${decision} seguido del código de la cita:\n` + wanted.map(o => `${decision} ${o.code} · ${o.appointment.patientName || 'Paciente'} · ${new Date(o.appointment.startsAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`).join('\n');
      }
      const offer = wanted[0], s = offer.appointment;
      if (offer.winner) {
        this.db.exec('COMMIT');
        return `✅ Esta cita ya fue confirmada por ${offer.winner.name}. Gracias por estar pendiente.`;
      }
      let result;
      if (decision === '2') {
        offer.declined.push(phone);
        result = 'Gracias por avisarnos. Registramos que no puedes atender esta teleconsulta. 💙';
      } else {
        offer.winner = { phone, name: this.doctorName(phone) };
        result = `✅ ${offer.winner.name}, confirmaste la teleconsulta de ${s.patientName || 'este paciente'}. ¡Gracias por tu atención! 💙`;
        for (const target of selectedDoctors(s, this.routes).filter(p => p !== phone)) {
          const text = `*VIP NOTIFICACIONES* 💙\n\n✅ Hola, ${this.doctorName(target)}.\n${offer.winner.name} confirmó que atenderá la teleconsulta de ${s.patientName || 'este paciente'}.\n🗓️ ${new Date(s.startsAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })} (Colombia)\n\nEsta cita ya está cubierta. Por favor, permanece pendiente de nuevas teleconsultas. ¡Muchas gracias por tu apoyo! 🙌`;
          this.enqueue(`claimed:${offer.code}:${target}`, s, 'claimed', target, now, { text });
        }
      }
      delete offer.appointment;
      this.saveOffer(offer);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  upcoming(now = Date.now()) {
    return this.db.prepare('SELECT payload FROM appointments').all().map(r => this.unseal(r.payload))
      .filter(s => s.status === 'confirmed' && Date.parse(s.startsAt) > now)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .map(s => ({ id: s.id, patientName: s.patientName || 'Nombre no disponible', startsAt: s.startsAt, doctorConfigured: selectedDoctors(s, this.routes).length > 0 }));
  }
  testDoctor(id, requestId, now = Date.now()) {
    if (typeof requestId !== 'string' || !/^[a-f\d-]{36}$/i.test(requestId)) throw new InputError('Identificador de prueba inválido');
    const s = typeof id === 'string' ? this.get(id) : null;
    if (!s || s.status !== 'confirmed' || Date.parse(s.startsAt) <= now) throw new InputError('Elige una cita confirmada y futura', 409);
    const doctors = selectedDoctors(s, this.routes);
    if (!doctors.length) throw new InputError('Esta cita no tiene médico asignado con WhatsApp configurado', 409);
    for (const doctor of doctors) this.enqueue(`test:${requestId}:${doctor}`, s, 'test_reminder', doctor, now);
    return { queued: true, message: 'Prueba en cola. El recordatorio automático se conserva.' };
  }
  async deliver(sender, now = Date.now(), { sourceHealthy = true } = {}) {
    if (this.delivering) return;
    this.delivering = true;
    try {
    const jobs = this.db.prepare(`SELECT * FROM jobs WHERE state='pending' AND due<=? ${sourceHealthy ? '' : "AND kind NOT IN ('reminder','exact','test_reminder')"} ORDER BY due LIMIT 100`).all(now);
    for (const job of jobs) {
      const payload = this.unseal(job.payload);
      if (['reminder', 'test_reminder', 'exact', 'claimed'].includes(job.kind)) {
        const current = this.get(job.appointment);
        const actualNow = Math.max(now, Date.now());
        const expired = current && (job.kind === 'reminder' || job.kind === 'test_reminder' ? Date.parse(current.startsAt) <= actualNow : actualNow > Date.parse(current.startsAt) + 120000);
        const offer = current && this.offer(current);
        if (!current || current.status !== 'confirmed' || current.startsAt !== payload.startsAt || expired || !selectedDoctors(current, this.routes).includes(payload.target) ||
            (job.kind !== 'claimed' && job.kind !== 'test_reminder' && (offer.declined.includes(payload.target) || (offer.winner && offer.winner.phone !== payload.target)))) {
          this.db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(job.id); continue;
        }
        if (job.kind !== 'claimed') {
          payload.text = message(current, job.kind, this.config.doctorPanel || 'https://medico.vip-mediconecta.app/panel-medico');
          if (job.kind !== 'test_reminder' && !offer.winner) payload.text += `\n\nPara confirmar, por favor escribe *1*. Si no puedes atender, escribe *2*.\nSi tienes varias citas, responde *1 ${offer.code}* o *2 ${offer.code}*.`;
          if (offer.winner) payload.text += `\n\n✅ Confirmada por ${offer.winner.name}.`;
        }
      }
      try {
        await sender.send(payload.target, payload.text);
      } catch {
        const attempts = job.attempts + 1;
        this.db.prepare('UPDATE jobs SET attempts=?,due=?,state=? WHERE id=?')
          .run(attempts, now + Math.min(3600000, 30000 * 2 ** attempts), attempts >= 8 ? 'failed' : 'pending', job.id);
        console.error(JSON.stringify({ event: 'delivery_failed', attempts }));
        continue;
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("UPDATE jobs SET state='sent' WHERE id=?").run(job.id);
        if (['reminder', 'exact'].includes(job.kind)) {
          this.db.prepare('INSERT OR IGNORE INTO reminders VALUES(?)').run(job.id);
          const offer = this.offer({ id: job.appointment, startsAt: payload.startsAt });
          if (!offer.notified.includes(payload.target)) offer.notified.push(payload.target);
          this.saveOffer(offer);
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      // A failed checkpoint stops delivery; never requeue an already sent message.
      await this.persist?.();
    }
    } finally { this.delivering = false; }
  }
  status() {
    const counts = this.db.prepare('SELECT state,COUNT(*) AS count FROM jobs GROUP BY state').all();
    const records = this.db.prepare('SELECT payload FROM appointments').all().map(r => this.unseal(r.payload));
    return { jobs: counts, appointments: records.length, missingDoctor: records.filter(s => s.status === 'confirmed' && !selectedDoctors(s, this.routes).length).length };
  }
  close() { this.db.close(); }
}
