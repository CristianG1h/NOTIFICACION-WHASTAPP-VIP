export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const options = {
  status: ['confirmed', 'rescheduling', 'uncertain', 'completed', 'cancelled'],
  payment: ['unknown', 'not_configured', 'not_required', 'manual_pending', 'pending', 'approved', 'declined', 'error', 'voided', 'abandoned'],
  form: ['unknown', 'pending', 'received', 'completed'],
};
export function snapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Se requiere una cita');
  const id = input.id;
  if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw new InputError('id inválido');
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new InputError('version debe ser un entero creciente');
  if (typeof input.startsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?(Z|[+-](?:0\d|1[0-3]):[0-5]\d)$/.test(input.startsAt) || !Number.isFinite(Date.parse(input.startsAt))) throw new InputError('startsAt requiere fecha ISO con zona horaria');
  const datePart = input.startsAt.slice(0, 10);
  if (new Date(`${datePart}T00:00:00Z`).toISOString().slice(0, 10) !== datePart) throw new InputError('Fecha inexistente');
  if (input.doctorId != null && (typeof input.doctorId !== 'string' || !/^[\w-]{1,100}$/.test(input.doctorId))) throw new InputError('doctorId inválido');
  if (input.patientName != null && (typeof input.patientName !== 'string' || input.patientName.length > 200)) throw new InputError('Nombre del paciente inválido');
  const out = { id, version: input.version, startsAt: new Date(input.startsAt).toISOString(), doctorId: input.doctorId || null, patientName: (input.patientName || '').replace(/[\s\u200b-\u200f\u202a-\u202e]+/g, ' ').trim() };
  for (const [key, values] of Object.entries(options)) {
    const value = input[key] ?? (key === 'status' ? 'confirmed' : 'unknown');
    if (!values.includes(value)) throw new InputError(`${key} inválido`);
    out[key] = value;
  }
  // Nombre autorizado para avisos; no documentos, historias clínicas ni destinatarios arbitrarios.
  return out;
}
export function selectedDoctor(s, routes) {
  if (s.doctorId === 'PROVIDER_UNAVAILABLE') return null;
  if (routes.forceDefaultDoctor && routes.defaultDoctorId && Object.hasOwn(routes.doctors, routes.defaultDoctorId)) {
    return routes.doctors[routes.defaultDoctorId];
  }
  const id = s.doctorId || routes.assignments[s.id] || routes.defaultDoctorId;
  return id && Object.hasOwn(routes.doctors, id) ? routes.doctors[id] : null;
}
export function selectedDoctors(s, routes) {
  if (s.doctorId === 'PROVIDER_UNAVAILABLE') return [];
  const phones = routes.broadcastDoctors ? Object.values(routes.doctors) : [selectedDoctor(s, routes)].filter(Boolean);
  return [...new Set(phones)];
}
const labels = {
  confirmed: 'Confirmada', rescheduling: 'Reprogramando', uncertain: 'Por verificar', completed: 'Completado', cancelled: 'Cancelada',
  unknown: 'Sin verificar', pending: 'Pendiente', approved: 'Pagado', declined: 'Rechazado',
  manual_pending: 'Pendiente de verificación manual', not_configured: 'No configurado', not_required: 'No requerido',
  error: 'Error', voided: 'Anulado', abandoned: 'Abandonado', received: 'Recibido (validación pendiente)',
};
export function message(s, kind, doctorPanel) {
  const when = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s.startsAt));
  const reminder = ['reminder', 'test_reminder', 'exact'].includes(kind);
  const title = kind === 'exact' ? '⏰ ¡Es hora de la teleconsulta!' : reminder ? '👨‍⚕️ Próxima consulta' : kind === 'created' ? '📋 Nueva cita' : '🗓️ Cambio de fecha u hora';
  const lines = ['*VIP NOTIFICACIONES* 💙', ...(kind === 'test_reminder' ? ['🧪 PRUEBA LOCAL — aviso adelantado'] : []), '', `*${title}*`, `👤 Paciente: ${s.patientName || 'Nombre no disponible'}`, `🗓️ Fecha y hora: ${when} (Colombia)`];
  if (reminder) lines.push(`📌 Estado: ${labels[s.status]}`, `${s.form === 'completed' ? '✅' : '📝'} Formulario: ${labels[s.form]}`, `${s.payment === 'approved' ? '✅' : '💳'} Pago: ${labels[s.payment]}`, `🔗 Panel médico: ${doctorPanel}`, '', '¡Gracias por cuidar de nuestros pacientes! 💙');
  return lines.join('\n');
}
