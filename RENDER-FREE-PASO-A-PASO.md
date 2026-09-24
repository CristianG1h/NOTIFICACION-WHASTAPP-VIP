# VIP NOTIFICACIONES V5 — Render Free + Baileys + MongoDB

## 1. GitHub
Sube todo este proyecto a un repositorio privado. No subas `.env`, `.data`, sesiones de WhatsApp ni bases SQLite.

## 2. Render
- Runtime: Node
- Plan: Free
- Build Command: `bash render-build.sh`
- Start Command: `npm start`
- Health Check Path: `/health`
- Node: `22.22.0`

## 3. Variables obligatorias

```text
API_TOKEN=<64 caracteres hexadecimales>
DATA_KEY=<64 caracteres hexadecimales>
WHATSAPP_MODE=baileys
SOURCE_MODE=vip-api
VIP_API_BASE_URL=https://vip-teleconsulta-api.onrender.com
VIP_API_TOKEN=<NOTIFICATIONS_READ_TOKEN del backend>
DOCTOR_PHONE=<57 + celular, solo números>
DOCTOR_ID=medico_principal
DOCTOR_FORCE_DEFAULT=true
MONGODB_URI=<cadena completa de MongoDB Atlas>
BAILEYS_SESSION_ID=vip-notificaciones-principal
```

Si tu `MONGODB_URI` ya incluye `/vip_notificaciones`, `MONGODB_DB` puede quedar vacío.

## 4. Grupo de control

Si ya tienes el ID, configura:

```text
CONTROL_GROUP_ID=120363XXXXXXXX@g.us
```

Si no lo tienes, abre `/admin/whatsapp`, ingresa `API_TOKEN`, vincula WhatsApp, pulsa **Cargar grupos**, selecciona el grupo y guarda. Luego copia el ID mostrado a `CONTROL_GROUP_ID` en Render.

## 5. Primera vinculación en V5

MongoDB estará vacío la primera vez. Abre:

`https://TU-SERVICIO.onrender.com/admin/whatsapp`

Escanea el QR una vez. Cuando la pantalla indique `WhatsApp conectado · sesión mongodb`, la autenticación ya se está guardando fuera de Render.

## 6. Comprobar persistencia

Abre:

`https://TU-SERVICIO.onrender.com/health`

Debe incluir:

```json
{
  "whatsappReady": true,
  "whatsappAuthStorage": "mongodb",
  "whatsappSessionId": "vip-notificaciones-principal"
}
```

Después haz un redeploy normal. Si vuelve a `whatsappReady: true` sin QR, la persistencia quedó confirmada.

## 7. Mantener Render Free activo

Tu monitor externo puede consultar periódicamente:

`https://TU-SERVICIO.onrender.com/health`

Ese endpoint no necesita `API_TOKEN`.

## 8. Memoria

V5 no usa `whatsapp-web.js`, Puppeteer ni Chromium. No necesitas `CHROME_PATH`, `PUPPETEER_SKIP_DOWNLOAD`, `NODE_OPTIONS` ni `MALLOC_ARENA_MAX` para este proyecto.

## 9. Importante

MongoDB conserva la **sesión de WhatsApp**. Otros archivos locales de Render Free siguen siendo temporales. Si WhatsApp cierra o revoca deliberadamente el dispositivo vinculado, habrá que vincularlo nuevamente aunque MongoDB conserve los documentos antiguos.
