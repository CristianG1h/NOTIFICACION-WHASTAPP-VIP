import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function recoverLock(directory, probe = pid => process.kill(pid, 0)) {
  const path = join(directory, 'worker.lock');
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const pid = Number(raw.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Bloqueo sin PID válido; requiere revisión manual.');
  try { probe(pid); }
  catch (error) {
    if (error.code !== 'ESRCH') throw new Error(`No se pudo comprobar el proceso ${pid}; se conserva el bloqueo.`);
    if (readFileSync(path, 'utf8') !== raw) throw new Error('El bloqueo cambió durante la comprobación; se conserva.');
    unlinkSync(path);
    return true;
  }
  throw new Error(`El proceso ${pid} sigue activo. Cierra esa instancia antes de iniciar otra.`);
}
