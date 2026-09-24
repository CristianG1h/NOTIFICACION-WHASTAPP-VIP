# Nombre del paciente y prueba inmediata del médico

## Actualización en Render

Copia `backend/src/server/store.ts` desde la carpeta `ACTUALIZACION-NOMBRES-GITHUB` a la misma ruta de tu repositorio en GitHub Desktop. Combina carpetas, haz Commit y Push y espera el despliegue en Render. Incluye también `backend/tests/notification-feed.test.ts` para conservar la prueba actualizada. No cambies claves ni vuelvas a escanear QR.

El lector privado ahora incluye `patientName` formado con nombres y apellidos del registro de VIP. El bot lo cifra junto con el resto del snapshot y lo muestra como `Paciente: ...`, en lugar de la referencia. El ID se conserva internamente y en el enlace MediConecta del médico. Hasta desplegar el lector, puede aparecer `Nombre no disponible`; nunca se inventa un nombre. Los mensajes ya enviados no se modifican.

## Reiniciar el bot actualizado

Detén la instancia anterior con Ctrl+C. En `VIP-NOTIFICACIONES`:

```powershell
npm.cmd start
```

Espera a ver WhatsApp conectado y deja que sincronice las citas. Si queda un bloqueo de un proceso terminado: `npm.cmd run unlock` y vuelve a iniciar.

## Probar al médico sin esperar

Con el bot abierto, abre otra terminal en la misma carpeta:

```powershell
npm.cmd run test:doctor
```

Elige el número de una cita futura de la lista. **Esa selección solicita un envío real al WhatsApp del médico asignado**, marcado `PRUEBA LOCAL — aviso adelantado`. Llegará en el próximo ciclo del bot si la fuente y WhatsApp están disponibles, normalmente unos 15 segundos más la respuesta de los servicios. El comando no cambia la hora de la cita ni consume el recordatorio automático. Si repites el comando, solicitas otra prueba.

Si la lista dice `médico NO disponible`, hay que confirmar la asignación en MediConecta y el alias/teléfono en `config.local.json`; no se envía al médico equivocado. Si indica que debes reiniciar, la instancia abierta todavía ejecuta el código anterior.

## Cuándo sale el aviso automático

| Tiempo restante al detectar la cita | Acción |
| --- | --- |
| Más de 15 minutos | Espera hasta entrar en la ventana de 15 minutos |
| Exactamente 15 minutos | Envía en ese ciclo |
| Entre 0 y 15 minutos (p. ej. 5 minutos) | Envía en ese ciclo; no espera otros 15 minutos |
| Hora ya pasada, cancelada o atendida | No envía un recordatorio de próxima consulta |

“En ese ciclo” significa después de detectar/sincronizar la cita; no es una garantía de entrega instantánea. El programa debe estar abierto y conectado. Una misma cita/hora/médico recibe un recordatorio automático; la prueba local es independiente.
