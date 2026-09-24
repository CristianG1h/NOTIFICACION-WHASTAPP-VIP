# Prueba Baileys en Render Free

Esta versión elimina `whatsapp-web.js`, Puppeteer y Chromium. Baileys se conecta por WebSocket y por eso usa mucha menos memoria.

## 1. GitHub

Sube **todo el contenido de esta carpeta** al mismo repositorio. Es importante que se eliminen del repositorio los archivos viejos `package-lock.json` y `.puppeteerrc.cjs` si todavía aparecen allí.

## 2. Render

Build Command:

```text
bash render-build.sh
```

Start Command:

```text
npm start
```

Usa **Manual Deploy → Clear build cache & deploy** en el primer despliegue de esta V4 para eliminar el Chromium/Puppeteer cacheado.

## 3. Environment

Cambia:

```text
WHATSAPP_MODE=baileys
```

Puedes eliminar estas variables si las agregaste para Puppeteer:

```text
CHROME_PATH
PUPPETEER_SKIP_DOWNLOAD
NODE_OPTIONS
MALLOC_ARENA_MAX
```

Mantén `DOCTOR_PHONE`, `API_TOKEN`, `DATA_KEY`, `VIP_API_TOKEN` y las demás variables del proyecto.

## 4. Conectar WhatsApp

Cuando el deploy termine, abre:

```text
https://TU-SERVICIO.onrender.com/admin/whatsapp
```

Escribe `API_TOKEN`, pulsa **Consultar** y escanea el QR desde WhatsApp → Dispositivos vinculados.

Cuando diga **WhatsApp conectado**, pulsa **Cargar grupos**. Selecciona el grupo de Control Teleconsultas VIP y guárdalo.

## 5. Importante para esta prueba

Por ahora Baileys usa `useMultiFileAuthState` y guarda la sesión en:

```text
.data/baileys-auth
```

En Render Free esa carpeta no es persistente tras un redeploy/reinicio. Esto es intencional para esta primera prueba: primero verificamos consumo de RAM, QR, grupos y envío. Después se implementa almacenamiento remoto de la sesión.
