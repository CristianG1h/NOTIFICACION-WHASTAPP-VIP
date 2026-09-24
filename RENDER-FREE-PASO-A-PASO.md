# VIP NOTIFICACIONES - Render Free

## 1. GitHub
Sube todo este proyecto a un repositorio privado. No subas `.env`, `.data`, sesiones de WhatsApp ni bases SQLite.

## 2. Crear Web Service en Render
- Runtime: Node
- Plan: Free
- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/health`

También puedes crear el servicio usando `render.yaml`.

## 3. Variables de entorno obligatorias

### API_TOKEN
Clave privada de 64 caracteres hexadecimales. Protege `/admin/whatsapp`, `/status` y endpoints administrativos.

### DATA_KEY
Clave privada de 64 caracteres hexadecimales. Cifra los datos guardados localmente por el bot.

### VIP_API_TOKEN
Debe coincidir EXACTAMENTE con `NOTIFICATIONS_READ_TOKEN` del backend VIP Teleconsulta.

### DOCTOR_PHONE
Número de WhatsApp del médico en formato internacional, solo números.
Ejemplo Colombia: `573001234567`.

## 4. Variables recomendadas

### DOCTOR_ID
Puedes dejar: `medico_principal`

### DOCTOR_FORCE_DEFAULT
Déjalo en `true` si este bot debe enviar todas las alertas médicas al número definido en `DOCTOR_PHONE`.

### CONTROL_GROUP_ID
La primera vez puede quedar vacío. Después de vincular WhatsApp:
1. Abre `https://TU-SERVICIO.onrender.com/admin/whatsapp`
2. Ingresa `API_TOKEN`.
3. Escanea el QR.
4. Pulsa `Cargar grupos`.
5. Selecciona el grupo de control.
6. Pulsa `Guardar grupo`.
7. Copia el ID que termina en `@g.us`.
8. En Render > Environment crea/actualiza `CONTROL_GROUP_ID` con ese ID.

Esto evita depender del archivo temporal de Render para recordar qué grupo usar.

## 5. Mantener Render Free activo
Configura tu monitor externo para solicitar periódicamente:

`https://TU-SERVICIO.onrender.com/health`

No necesita `API_TOKEN`.

## 6. Conectar WhatsApp sin terminal
Usa:

`https://TU-SERVICIO.onrender.com/admin/whatsapp`

El panel muestra el QR directamente en el navegador, por lo que no necesitas Shell/Terminal de Render.

## 7. Importante sobre Render Free
Mantener `/health` recibiendo peticiones evita la inactividad mientras las peticiones sigan llegando, pero el almacenamiento local de un servicio Free sigue siendo temporal. Si Render reinicia o haces un redeploy, la sesión de WhatsApp puede requerir vinculación otra vez. El grupo no se pierde si guardaste su ID en `CONTROL_GROUP_ID`.
