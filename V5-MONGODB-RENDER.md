# VIP Notificaciones V5 — Baileys + MongoDB Atlas

Esta versión mantiene Baileys (sin Chrome/Puppeteer) y mueve únicamente la sesión de WhatsApp desde `.data/baileys-auth` a MongoDB Atlas.

## Variables nuevas en Render

En **Render → Environment** agrega:

```text
MONGODB_URI=mongodb+srv://USUARIO:CONTRASENA@HOST/vip_notificaciones?retryWrites=true&w=majority&appName=NOTIFICACIONES
BAILEYS_SESSION_ID=vip-notificaciones-principal
```

`MONGODB_DB` es opcional. Si `MONGODB_URI` ya incluye `/vip_notificaciones`, déjalo vacío.

No guardes `MONGODB_URI` en GitHub ni en un `.env` publicado.

## Primera instalación de V5

1. Sube todos los archivos de V5 al repositorio GitHub.
2. Render: Build Command `bash render-build.sh`.
3. Render: Start Command `npm start`.
4. Verifica que `WHATSAPP_MODE=baileys`.
5. Agrega `MONGODB_URI` y `BAILEYS_SESSION_ID`.
6. Haz **Deploy latest commit**. No necesitas Chrome ni Puppeteer.
7. Abre `/admin/whatsapp`, ingresa `API_TOKEN` y vincula WhatsApp una última vez si MongoDB todavía está vacío.
8. Espera a que indique `WhatsApp conectado · sesión mongodb`.

## Comprobar persistencia

Abre `/health`. Debes ver:

```json
{
  "whatsappReady": true,
  "whatsappAuthStorage": "mongodb",
  "whatsappSessionId": "vip-notificaciones-principal"
}
```

Luego haz un redeploy normal de Render. Si MongoDB quedó guardando la sesión, el bot debe volver a `whatsappReady: true` sin pedir QR.

## Qué se guarda

La colección `baileys_auth` guarda exclusivamente el estado de autenticación que Baileys necesita: `creds`, pre-keys, sessions, sender keys y app-state keys. No se guarda el historial de conversaciones del usuario.

## Si la sesión se cierra desde el teléfono

Baileys mostrará `logged_out`. En ese caso esa sesión ya no es válida y debe volver a vincularse. La persistencia protege contra reinicios/redeploys de Render; no evita que WhatsApp revoque deliberadamente un dispositivo vinculado.
