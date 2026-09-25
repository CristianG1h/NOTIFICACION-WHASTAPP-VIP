import { ADMIN_PHONES } from './doctors.js';

export class Conversation {
  constructor(store, doctors) {
    this.store = store; this.doctors = doctors; this.sessions = new Map();
  }
  menu(phone, now) {
    const doctors = this.doctors.list();
    this.sessions.set(phone, { step: 'list', ids: doctors.map(d => d.id), expires: now + 600000 });
    return `*👨‍⚕️ MÉDICOS VIP*\n\n${doctors.map((d, i) => `${i + 1}. ${d.name} · ${d.phone}`).join('\n') || 'No hay médicos guardados.'}\n\n${doctors.length + 1}. ➕ Agregar médico\n\nEscribe el número de la opción.\nEscribe CANCELAR para salir.\nTodos los médicos guardados recibirán las solicitudes al administrar esta lista.`;
  }
  async text(phone, input, now = Date.now()) {
    const text = String(input).trim(), command = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const admin = ADMIN_PHONES.includes(phone);
    const doctor = this.doctors.list().some(d => d.phone === phone);
    if (!admin && !doctor) return null;
    if (admin && /^(medico|medicos|menu)$/.test(command)) return this.menu(phone, now);
    if (command === 'cancelar' && admin) { this.sessions.delete(phone); return 'Menú cerrado. Escribe MEDICO cuando lo necesites.'; }
    let session = this.sessions.get(phone);
    if (session?.expires <= now) { this.sessions.delete(phone); session = null; }
    // Explicit appointment codes always take precedence over an open admin menu.
    const response = /^([12])(?:\s+([a-f\d]{12}))?$/i.exec(text);
    if (doctor && response && (!session || response[2])) return this.store.respond(phone, response[1], response[2], now);
    if (!admin) return 'Para responder a una teleconsulta, escribe 1 para confirmar o 2 si no puedes atender. Si tienes varias, añade el código de la cita.';
    if (!session) return 'Escribe *MEDICO* para ver, agregar, modificar o eliminar médicos.';
    session.expires = now + 600000;
    const list = this.doctors.list();
    if (session.step === 'list') {
      if (!/^\d+$/.test(text)) return 'Escribe el número de una opción o CANCELAR.';
      const index = Number(text) - 1;
      if (index === session.ids.length) {
        session.step = 'name'; session.id = null;
        return '➕ Agregar médico\nEscribe el nombre del médico:';
      }
      const selected = list.find(d => d.id === session.ids[index]);
      if (!selected) return this.menu(phone, now);
      session.id = selected.id; session.step = 'action';
      return `👨‍⚕️ ${selected.name}\n📱 ${selected.phone}\n\n1. Modificar\n2. Eliminar\n0. Volver`;
    }
    if (session.step === 'action') {
      if (text === '0') return this.menu(phone, now);
      if (text === '1') { session.step = 'name'; return 'Escribe el nombre del médico (puedes repetir el actual):'; }
      if (text === '2') { session.step = 'delete'; return '¿Eliminar este médico? Escribe ELIMINAR para confirmar o CANCELAR para salir.'; }
      return 'Selecciona 1 para modificar, 2 para eliminar o 0 para volver.';
    }
    if (session.step === 'delete') {
      if (command !== 'eliminar') return 'Para eliminar escribe ELIMINAR. Para salir escribe CANCELAR.';
      await this.doctors.remove(session.id);
      return `✅ Médico eliminado.\n\n${this.menu(phone, now)}`;
    }
    if (session.step === 'name') {
      if (!text || text.length > 80) return 'Escribe un nombre de 1 a 80 caracteres.';
      session.name = text; session.step = 'phone';
      return '📱 Escribe el celular: 57 + 10 dígitos. Ejemplo: 573001234567.\nSi escribes solo los 10 dígitos, agregaré el 57 automáticamente.';
    }
    if (session.step === 'phone') {
      try {
        const saved = await this.doctors.upsert(session.id, session.name, text);
        return `✅ Guardado: ${saved.name} · ${saved.phone}\n\n${this.menu(phone, now)}`;
      } catch (error) {
        // Validation is actionable; infrastructure details must stay out of chat.
        if (/número|Número|celular|nombre|médico|Límite/.test(error.message)) return error.message;
        console.error('No se pudo persistir el directorio médico.');
        return 'No se pudo guardar el cambio. Intenta otra vez enviando el número; no se ha confirmado el guardado.';
      }
    }
    return this.menu(phone, now);
  }
  async receive({ id, phone, text }, now = Date.now()) {
    if (!id || this.store.db.prepare('SELECT id FROM inbound WHERE id=?').get(id)) return;
    const reply = await this.text(phone, text, now);
    if (!reply) return;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('INSERT OR IGNORE INTO inbound VALUES(?,?)').run(id, now);
      this.store.db.prepare('INSERT OR IGNORE INTO jobs(id,appointment,kind,payload,due) VALUES(?,?,?,?,?)')
        .run(`reply:${id}`, 'conversation', 'reply', this.store.seal({ target: phone, text: reply }), now);
      this.store.db.prepare('DELETE FROM inbound WHERE received<?').run(now - 7 * 86400000);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
}

// Trust transport identity only. Display names and message text are never identities.
export async function incomingMessage(message, socket) {
  const key = message?.key, jid = key?.remoteJid;
  if (!key?.id || key.fromMe || !jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return null;
  const timestamp = Number(message.messageTimestamp);
  if (timestamp && Date.now() - timestamp * 1000 > 600000) return null;
  let pn = jid;
  if (jid.endsWith('@lid')) {
    pn = key.remoteJidAlt?.endsWith('@s.whatsapp.net') ? key.remoteJidAlt : await socket.signalRepository?.lidMapping?.getPNForLID(jid);
  }
  if (!pn?.endsWith('@s.whatsapp.net')) return null;
  const phone = pn.split('@')[0].split(':')[0];
  let content = message.message;
  for (let i = 0; i < 3; i++) {
    const inner = content?.ephemeralMessage?.message || content?.viewOnceMessage?.message || content?.viewOnceMessageV2?.message;
    if (!inner) break;
    content = inner;
  }
  const text = content?.conversation || content?.extendedTextMessage?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 1000) return null;
  return { id: `${phone}:${key.id}`, phone, text };
}
