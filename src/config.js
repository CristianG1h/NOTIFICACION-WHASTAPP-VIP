import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function jsonObject(value, name) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${name} debe contener JSON válido`);
  }
}

function defaultDataDir(env) {
  return env.DATA_DIR || (env.RENDER ? '/var/data/vip-notificaciones' : '.data');
}

export function configuration(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const n = Number(env[name] || fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Configura ${name}`);
    return n;
  };
  if (!/^[a-f\d]{64}$/i.test(env.DATA_KEY || '')) throw new Error('Falta DATA_KEY: debe tener 64 caracteres hexadecimales');
  if (!/^[a-f\d]{64}$/i.test(env.API_TOKEN || '')) throw new Error('Falta API_TOKEN: debe tener 64 caracteres hexadecimales');
  const mode = env.WHATSAPP_MODE || 'mock';
  const source = env.SOURCE_MODE || 'webhook';
  if (!['mock', 'web', 'baileys'].includes(mode) || !['webhook', 'sqlite', 'vip-api'].includes(source)) throw new Error('Modo inválido');
  const base = new URL(env.MEDICONNECTA_BASE_URL || 'https://vip-mediconecta.app');
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('Base MediConecta inválida');
  const doctorPanel = new URL(env.DOCTOR_PANEL_URL || 'https://medico.vip-mediconecta.app/panel-medico');
  if (doctorPanel.protocol !== 'https:' || doctorPanel.username || doctorPanel.password || doctorPanel.search || doctorPanel.hash) throw new Error('DOCTOR_PANEL_URL inválida');
  return {
    mode,
    source,
    base: base.origin,
    doctorPanel: doctorPanel.toString(),
    key: Buffer.from(env.DATA_KEY, 'hex'),
    token: env.API_TOKEN,
    directory: resolve(defaultDataDir(env)),
    host: env.HOST || (env.RENDER ? '0.0.0.0' : '127.0.0.1'),
    port: integer('PORT', 3210, 1, 65535),
    reminderMinutes: integer('REMINDER_MINUTES', 15, 1, 1440),
    pollSeconds: integer('POLL_SECONDS', 15, 5, 3600),
  };
}

export function routing(file = 'config.local.json', env = process.env) {
  let r;
  if (env.ROUTING_JSON) {
    r = jsonObject(env.ROUTING_JSON, 'ROUTING_JSON');
  } else if (existsSync(file)) {
    r = JSON.parse(readFileSync(file, 'utf8'));
  } else if (existsSync('config.example.json')) {
    r = JSON.parse(readFileSync('config.example.json', 'utf8'));
  } else {
    r = { controlGroupId: '', defaultDoctorId: '', doctors: {}, assignments: {}, mediconecta: {} };
  }

  // Overrides simples para Render. Permiten cambiar médico/grupo sin editar GitHub.
  // DOCTOR_PHONE usa formato internacional solo números, por ejemplo 573001234567.
  if (env.DOCTOR_PHONE) {
    const doctorId = (env.DOCTOR_ID || 'medico_principal').trim();
    r.doctors ||= {};
    r.assignments ||= {};
    r.doctors[doctorId] = env.DOCTOR_PHONE.trim();
    r.defaultDoctorId = doctorId;
    // Para una instalación con un solo médico, el teléfono de Render puede
    // actuar como destino global incluso si la API trae otro doctorId.
    r.forceDefaultDoctor = env.DOCTOR_FORCE_DEFAULT !== 'false';
  }
  if (env.CONTROL_GROUP_ID) r.controlGroupId = env.CONTROL_GROUP_ID.trim();

  // Runtime-only choices (por ejemplo el grupo seleccionado desde /admin/whatsapp).
  // En Render Free este archivo es temporal; para conservar el grupo entre reinicios
  // copia el ID mostrado por el panel a CONTROL_GROUP_ID en Environment.
  const runtimeFile = resolve(defaultDataDir(env), 'routing.runtime.json');
  if (existsSync(runtimeFile)) {
    const runtime = jsonObject(readFileSync(runtimeFile, 'utf8'), 'routing.runtime.json');
    if (!env.CONTROL_GROUP_ID && typeof runtime.controlGroupId === 'string') r.controlGroupId = runtime.controlGroupId;
  }

  if (!r || typeof r !== 'object' || !r.doctors || !r.assignments) throw new Error('Configuración de destinatarios inválida');
  if (r.controlGroupId && !/^\d+(?:-\d+)?@g\.us$/.test(r.controlGroupId)) throw new Error('ID de grupo inválido');
  for (const [id, phone] of Object.entries(r.doctors)) {
    if (!/^[\w-]{1,100}$/.test(id) || typeof phone !== 'string' || !/^[1-9]\d{7,14}$/.test(phone)) throw new Error('Médico inválido: usa teléfono internacional sin +');
  }
  if (r.defaultDoctorId && !Object.hasOwn(r.doctors, r.defaultDoctorId)) throw new Error('Médico predeterminado no configurado');
  for (const id of Object.values(r.assignments)) if (!Object.hasOwn(r.doctors, id)) throw new Error('Asignación sin teléfono de médico');
  return r;
}
