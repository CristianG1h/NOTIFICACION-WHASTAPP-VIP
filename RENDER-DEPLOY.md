# VIP NOTIFICACIONES en Render

## Recomendación para producción

Para que este bot quede realmente encendido y conserve la sesión de WhatsApp, usa un **Web Service de pago con Persistent Disk**. Un servicio Free de Render se suspende por inactividad y no conserva el sistema de archivos, por lo que no sirve para un bot que debe permanecer conectado 24/7.

El proyecto ya queda preparado para Render:

- escucha en `0.0.0.0`;
- respeta el `PORT` de Render;
- `npm start` funciona aunque no exista archivo `.env`;
- usa flags de Chromium apropiados para Linux/headless;
- guarda sesión de WhatsApp y SQLite dentro de `DATA_DIR`;
- incluye `/health`;
- incluye `/admin/whatsapp` para vincular por QR sin Shell/Terminal;
- permite elegir el grupo de control desde el navegador;
- evita que un `worker.lock` persistido bloquee un reinicio en Render.

## 1. GitHub

Sube el proyecto SIN estos elementos:

- `.env`
- `.data/`
- `config.local.json`
- `.wwebjs_cache/`
- `node_modules/`

Ya están cubiertos por `.gitignore`.

## 2. Crear el servicio

Puedes usar `render.yaml` como Blueprint o crear un Web Service manualmente.

Configuración manual:

- Runtime: Node
- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/health`
- Plan: uno que no se suspenda por inactividad
- Persistent Disk: montar en `/var/data/vip-notificaciones`
- `DATA_DIR=/var/data/vip-notificaciones`

## 3. Variables de entorno

Configura en Render > Environment:

```dotenv
HOST=0.0.0.0
WHATSAPP_MODE=web
SOURCE_MODE=vip-api
VIP_API_BASE_URL=https://vip-teleconsulta-api.onrender.com
MEDICONNECTA_BASE_URL=https://vip-mediconecta.app
DOCTOR_PANEL_URL=https://medico.vip-mediconecta.app/panel-medico
REMINDER_MINUTES=15
POLL_SECONDS=15
DATA_DIR=/var/data/vip-notificaciones
```

También debes agregar tus secretos reales:

```dotenv
API_TOKEN=<64 caracteres hexadecimales>
DATA_KEY=<64 caracteres hexadecimales>
VIP_API_TOKEN=<token que coincide con NOTIFICATIONS_READ_TOKEN del backend VIP>
```

Puedes generar `API_TOKEN` y `DATA_KEY` en tu PC con:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Ejecuta el comando dos veces y usa un valor distinto para cada variable.

### ROUTING_JSON

Como `config.local.json` NO debe subirse a GitHub, copia su contenido como una variable secreta llamada `ROUTING_JSON`, en una sola línea JSON.

Ejemplo de estructura:

```json
{"controlGroupId":"","defaultDoctorId":"","doctors":{"YULI":"57XXXXXXXXXX"},"assignments":{},"mediconecta":{"doctorIdPath":"medico","requireDoctorAlias":true,"doctorAliases":{"YULI":"YULI"},"formLookup":"bsl-wix-id","statusPath":"atendido","completedStatusValues":["ATENDIDO"],"paymentPath":"pagado","paymentApprovedValues":[true,1,"true","PAGADO","Pagado","pagado"]}}
```

Puedes dejar `controlGroupId` vacío y seleccionarlo luego desde la página web de administración.

Si vas a consultar MediConecta:

```dotenv
MEDICONNECTA_LOOKUP=true
MEDICONNECTA_AUTH_MODE=bearer
MEDICONNECTA_TOKEN=<token autorizado>
```

Si aún no tienes acceso autorizado, deja `MEDICONNECTA_LOOKUP=false` para que el servicio pueda iniciar sin esa dependencia.

## 4. Vincular WhatsApp sin terminal de Render

Después del deploy abre:

```text
https://TU-SERVICIO.onrender.com/admin/whatsapp
```

1. Pega tu `API_TOKEN`.
2. Pulsa **Consultar**.
3. Si la sesión todavía no existe, aparecerá el QR.
4. En el teléfono: WhatsApp > Dispositivos vinculados > Vincular un dispositivo.
5. Escanea el QR.
6. Cuando diga **WhatsApp conectado**, pulsa **Cargar grupos**.
7. Elige `Control Teleconsultas VIP` y pulsa **Guardar grupo**.

La selección del grupo se guarda en el disco persistente como `routing.runtime.json`.

## 5. ¿Se pierde la sesión?

Con `LocalAuth`, WhatsApp guarda la sesión en:

```text
/var/data/vip-notificaciones/whatsapp
```

Con un Persistent Disk montado exactamente sobre `/var/data/vip-notificaciones`, la sesión se conserva en reinicios y redeploys normales.

Sin Persistent Disk, Render usa almacenamiento efímero: la sesión, la SQLite de notificaciones y la selección de grupo pueden desaparecer al reiniciar/redeployar.

## 6. Comprobación

Abre:

```text
https://TU-SERVICIO.onrender.com/health
```

Cuando todo esté correcto debe mostrar, entre otros datos:

```json
{"whatsappReady":true,"whatsappPhase":"ready"}
```

Los logs seguirán siendo útiles para errores de Chromium, autenticación, fuente VIP y entregas, pero ya no necesitas una terminal para escanear el QR o elegir el grupo.
