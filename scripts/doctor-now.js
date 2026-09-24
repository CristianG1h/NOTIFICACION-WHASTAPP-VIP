import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
const terminal = createInterface({ input: stdin, output: stdout });
const base = `http://127.0.0.1:${Number(process.env.PORT || 3210)}`;
const headers = { Authorization: `Bearer ${process.env.API_TOKEN}`, 'Content-Type': 'application/json' };
try {
  const response = await fetch(`${base}/local/upcoming`, { headers, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Reinicia el bot actualizado con npm.cmd start y vuelve a ejecutar este comando.');
  const list = await response.json();
  if (!list.length) throw new Error('No hay citas futuras confirmadas. Espera la sincronización o agenda una cita de prueba.');
  list.forEach((s, i) => console.log(`${i + 1}. ${s.patientName} — ${new Date(s.startsAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })} — médico ${s.doctorConfigured ? 'configurado' : 'NO disponible'}`));
  const selected = list[Number(await terminal.question('Número de la cita para enviar una PRUEBA AHORA al médico: ')) - 1];
  if (!selected) throw new Error('Selección inválida');
  if (!selected.doctorConfigured) throw new Error('Falta asignar/configurar el médico de esta cita; no se enviará a otro médico.');
  const r = await fetch(`${base}/local/test-doctor`, { method: 'POST', headers, body: JSON.stringify({ id: selected.id, requestId: randomUUID() }), signal: AbortSignal.timeout(5000) });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error);
  console.log('Prueba en cola: llegará en el próximo ciclo si la fuente y WhatsApp están disponibles. No cambia la cita ni consume el aviso automático de 15 minutos.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { terminal.close(); }
