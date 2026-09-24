import { resolve } from 'node:path';
import { recoverLock } from '../src/recover-lock.js';
try {
  console.log(recoverLock(resolve(process.env.DATA_DIR || '.data'))
    ? 'Bloqueo de un proceso terminado eliminado. La sesión de WhatsApp se conserva.'
    : 'No hay bloqueo pendiente.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
