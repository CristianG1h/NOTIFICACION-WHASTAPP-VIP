# V4 PRUEBA BAILEYS EN RENDER FREE

Esta variante reemplaza `whatsapp-web.js` + Puppeteer/Chromium por `@whiskeysockets/baileys`. No requiere navegador y está pensada para probar primero si el bot permanece dentro de los 512 MB de Render Free. La sesión se guarda **solo localmente** en `.data/baileys-auth` durante esta prueba; la persistencia remota se implementará después de validar el funcionamiento.

Consulta `BAILEYS-PRUEBA-RENDER.md` para el despliegue.

---

# IMPORTANTE - VERSION FINAL RENDER FREE

Para desplegar esta versión lee primero `RENDER-FREE-PASO-A-PASO.md` y `VARIABLES-RENDER.txt`.

Variables simplificadas añadidas: `DOCTOR_PHONE`, `DOCTOR_ID` y `CONTROL_GROUP_ID`.

# VIP NOTIFICACIONES

**Nombres y prueba del médico:** [PRUEBA-MEDICO-Y-NOMBRES.md](PRUEBA-MEDICO-Y-NOMBRES.md). Los avisos ahora muestran el nombre del paciente; la prueba local se solicita con `npm.cmd run test:doctor` mientras el bot está abierto.

**Despliegue permanente en Render:** empieza por [RENDER-DEPLOY.md](RENDER-DEPLOY.md). El proyecto incluye `render.yaml`, health check, soporte para Persistent Disk y una página protegida `/admin/whatsapp` para escanear el QR y elegir el grupo sin necesitar Shell/Terminal de Render.

Proyecto independiente del sitio VIP TELECONSULTA. Detecta las citas creadas en la web VIP, informa al grupo **Control Teleconsultas VIP** y recuerda la próxima consulta al médico asignado en MediConecta.

**Estado de entrega:** implementado y probado con datos ficticios. No se ha vinculado ningún WhatsApp, enviado mensajes reales ni configurado acceso a datos de producción. La consulta autenticada a MediConecta requiere un token autorizado y confirmar sus campos de respuesta. No debe confundirse la simulación con una integración real ya activa.

## Flujo

```text
Web VIP → backend VIP → SQLite cifrado (lectura, sin modificar el backend)
                              │
                     VIP NOTIFICACIONES
                              ├─ Consulta la orden conocida en MediConecta
                              │    → identificador del médico / estado del formulario
                              ├─ Grupo: nueva cita y cambios de estado/pago/formulario
                              └─ Médico: aviso 15 minutos antes
                                   → hora Colombia, formulario, pago, enlace al panel médico
```

- Detecta cambios cada 15 segundos, configurables.
- El pago electrónico proviene del backend VIP, que verifica los eventos de Wompi. Si MediConecta marca manualmente la orden con `pagado=true`, el bot la promueve a **Pagado** sin degradar un pago Wompi ya aprobado.
- El formulario aparece como **Sin verificar** hasta disponer de una respuesta confirmada de MediConecta. Guardar el formulario de reserva de la web no demuestra que se haya completado el formulario médico.
- El identificador de médico de MediConecta se relaciona con su WhatsApp en `config.local.json`. No se extraen ni adivinan teléfonos.
- Se consulta solamente la orden asociada a una cita originada en VIP. No se enumeran pacientes ni todas las órdenes de MediConecta.
- El recordatorio del médico usa el panel dedicado configurado en `DOCTOR_PANEL_URL` (por defecto `https://medico.vip-mediconecta.app/panel-medico`).
- Sin médico configurado se informa al grupo; no se envía a un destinatario arbitrario.
- Los avisos incluyen nombre del paciente, sin documento ni historia clínica. El identificador se conserva internamente y en el enlace de acceso del médico.

## Inicio rápido

Requiere Node.js 22.17 o superior. En PowerShell, dentro de esta carpeta:

```powershell
npm ci
npm run setup
npm test
npm run demo
```

`demo` imprime tres mensajes ficticios y no se conecta a WhatsApp. `setup` crea claves y configuración local sin sobrescribir archivos existentes. Las dependencias ya fueron instaladas en la copia de entrega.

Después sigue [CONECTAR-WHATSAPP.md](CONECTAR-WHATSAPP.md) y [CONEXION-MEDICONECTA.md](CONEXION-MEDICONECTA.md).

## Fuente de citas: SQLite del backend VIP

En `.env` configura:

```dotenv
SOURCE_MODE=sqlite
VIP_DATABASE_PATH="C:/ruta/al/backend/.data/requests.live.sqlite"
VIP_DATA_ENCRYPTION_KEY=CLAVE_HEXADECIMAL_DE_64_CARACTERES_DEL_BACKEND
MEDICONNECTA_LOOKUP=true
MEDICONNECTA_TOKEN=TOKEN_AUTORIZADO
```

El backend llama a la base `requests.live.sqlite` en modo live y `requests.mock.sqlite` en modo demo. No copies una base demo esperando observar citas de producción. Para el backend local en desarrollo puede utilizarse `VIP_DEVELOPMENT_KEY_PATH` apuntando a `development.key` en lugar de la clave hexadecimal.

**La base debe ser accesible desde el proceso del bot.** Si el backend real está en Render, la base de tu PC no contiene sus citas. Para este modo, ambos procesos necesitan ejecutarse en un servidor con acceso al mismo disco. Dos servicios independientes de Render no comparten automáticamente un Persistent Disk. El proyecto es independiente aunque se ejecute en el mismo servidor. No se ha cambiado ni desplegado el backend existente.

La primera sincronización registra las citas existentes sin enviar al grupo un historial de altas. Sus consultas futuras sí pueden generar recordatorios. Desde esa sincronización, las altas detectadas, incluso después de reiniciar el bot, se notifican. El sondeo observa estados finales: dos cambios ocurridos entre sondeos pueden resumirse en una sola actualización.

## Fuente alternativa: eventos HTTPS

Para alojar el bot en otro servidor, existe `POST /events/appointment`. Es necesario que el backend o un adaptador autorizado produzca estos eventos; el backend actual **todavía no los emite**. Este modo permite conectar otra infraestructura sin compartir SQLite. El emisor debe incluir el médico y formulario consultados a MediConecta y repetir eventos hasta recibir respuesta, conservando la misma versión. En modo webhook, el bot confía en esos campos y no sondea MediConecta por su cuenta.

```http
POST /events/appointment
Authorization: Bearer API_TOKEN_DEL_BOT
Content-Type: application/json
```

```json
{
  "id": "ID_REAL_DE_LA_ORDEN_MEDICONECTA",
  "version": 1780000000001,
  "startsAt": "2027-01-15T10:30:00-05:00",
  "doctorId": "ID_REAL_DEL_MEDICO",
  "status": "confirmed",
  "payment": "approved",
  "form": "completed"
}
```

- `version`: entero estrictamente creciente por cita. Duplicados idénticos se ignoran; misma versión con contenido distinto devuelve 409; versiones antiguas se ignoran.
- `status`: `confirmed`, `rescheduling`, `uncertain`, `completed`, `cancelled`.
- `payment`: `unknown`, `not_configured`, `not_required`, `manual_pending`, `pending`, `approved`, `declined`, `error`, `voided`, `abandoned`.
- `form`: `unknown`, `pending`, `received` (guardado, sin afirmar validación clínica), `completed`.
- `doctorId`: identificador que figura en `doctors`, o `null` si falta asignación.
- `startsAt`: fecha ISO con zona horaria. Se presenta al usuario en hora de Colombia.

No se aceptan destinatarios ni URLs arbitrarios en los eventos. El token se guarda en servidor; nunca en la web pública ni GitHub Pages. Localmente el servicio escucha en `127.0.0.1`; cuando Render define `RENDER`, usa `0.0.0.0` por defecto y el `PORT` suministrado por la plataforma. No habilita CORS para la web.

## Operación

```powershell
npm start
```

- `GET /health`: modo, conexión a WhatsApp y salud de la fuente.
- `GET /status`: requiere `Authorization: Bearer API_TOKEN`; informa citas, médicos faltantes y estados de cola.
- `Ctrl+C`: cierre del servidor y del navegador conservando la sesión.
- Reprogramar, cancelar o cambiar de médico invalida recordatorios pendientes.
- Por cita, hora y médico se entrega un recordatorio. Cambios posteriores de pago/formulario se avisan al grupo; no disparan un segundo recordatorio al mismo médico.
- Fallos de envío: hasta 8 intentos, con espera creciente, luego estado `failed`. Revisar `/status`; no hay reintento infinito ni panel de recuperación automática.
- Un envío confirmado por la biblioteca se marca `sent`; no significa que el destinatario lo leyó.
- La cola evita duplicados habituales, pero WhatsApp Web no ofrece una clave de idempotencia: una caída justo después de enviar y antes de guardar puede duplicar un mensaje al reiniciar.
- La base del bot cifra los cuerpos y destinatarios con `DATA_KEY`. Conserva la clave junto a copias de seguridad protegidas. Las referencias de orden y metadatos operativos de SQLite no están cifrados.
- La sesión de WhatsApp es guardada por `LocalAuth` en `.data/whatsapp`; **no** está protegida por `DATA_KEY`. Restringe el acceso a esa carpeta y no la publiques.
- Modo `mock` y modo `web` tienen bases distintas: probar no consume recordatorios reales.
- No ejecutes dos instancias locales contra la misma sesión. `worker.lock` lo impide localmente. En Render no se persiste ese lock, porque un lock antiguo en el disco podría impedir el siguiente arranque.
- En local, mantén el equipo encendido, conectado y sin suspensión. En Render usa un servicio que no se suspenda y un Persistent Disk. Si WhatsApp invalida la sesión por su cuenta, vuelve a vincular desde `/admin/whatsapp`.
- Datos y cola se conservan; no se aplica una política automática de borrado. Define retención y respaldo antes de uso prolongado.

## WhatsApp: alcance de esta implementación

Usa `whatsapp-web.js` y el grupo existente de tu cuenta, mediante QR. **Es una integración no oficial; puede dejar de funcionar o generar restricciones/bloqueos de la cuenta.** No equivale a la API oficial de Meta. Consulta la advertencia del [propio proyecto](https://wwebjs.dev/guide/).

No se afirma que la API oficial carezca de grupos: Meta dispone de documentación específica y condiciones que hay que validar para cada cuenta. No se ha confirmado que pueda utilizarse con tu grupo actual. Esta entrega implementa el camino de WhatsApp Web.

Se fija Puppeteer 25.12.0 para evitar la dependencia vulnerable `extract-zip` de la versión fijada por whatsapp-web.js. Hay una comprobación de arranque de Chromium sin WhatsApp en la entrega; la compatibilidad con la sesión real requiere el QR y una prueba con tu cuenta.
