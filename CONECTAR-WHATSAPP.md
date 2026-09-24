# Cómo conectar tu WhatsApp

**Si WhatsApp ya está vinculado y quieres recibir las citas de la web publicada:** sigue [PASO-A-PASO-RENDER.md](PASO-A-PASO-RENDER.md). No es necesario repetir el QR ni configurar una base SQLite compartida cuando utilizas `vip-api`.

## 1. Prepara el número y el grupo

Usa preferentemente un número dedicado al trabajo. Añádelo al grupo **Control Teleconsultas VIP**. Debe poder escribir en ese grupo; si solo escriben administradores, dale ese permiso.

Este bot se vincula como un dispositivo de WhatsApp Web. No necesitas entregar la contraseña ni escribir códigos en este chat. La biblioteca es no oficial y existe riesgo de desconexión o bloqueo de cuenta.

## 2. Abre PowerShell en la carpeta del proyecto

```powershell
cd 'C:\Users\crist\Downloads\VIP-TELECONSULTA final\VIP-NOTIFICACIONES'
npm ci
npm run setup
npm run connect
```

`npm ci` puede tardar porque instala el navegador. Si ya está instalado, puedes empezar en `npm run connect`. Detén antes `npm start` si estaba ejecutándose.

## 3. Escanea el QR

En el teléfono abre **WhatsApp → Dispositivos vinculados → Vincular un dispositivo**. En iPhone esa opción se encuentra en Configuración; en Android, en el menú de WhatsApp. Escanea el QR que aparece en PowerShell.

Espera a ver **WhatsApp conectado**. El programa mostrará tus grupos: escribe el número correspondiente a **Control Teleconsultas VIP**. No elijas un grupo de pacientes.

Después puedes guardar el teléfono de un médico (código de país y número, sin `+`, por ejemplo `573001234567`) y **su identificador real en MediConecta**. Si aún no sabes el identificador, pulsa Enter y configúralo después.

El asistente guarda la sesión y los destinatarios. **Vincular no envía mensajes ni activa por sí solo las notificaciones.**

## 4. Conecta las citas y el médico

Abre `.env` y configura la ruta de la base real VIP y su clave, siguiendo [la guía de conexión](CONEXION-MEDICONECTA.md). Para el médico necesitas el token autorizado de MediConecta y confirmar la ruta del campo que identifica al profesional.

En `config.local.json`, `doctors` relaciona cada identificador real con su número:

```json
"doctors": {
  "ID_MEDICO_1": "573001234567",
  "ID_MEDICO_2": "573009876543"
}
```

Mantén `defaultDoctorId` vacío para que cada aviso dependa de la asignación consultada a MediConecta. `assignments` solo sirve como alternativa manual explícita por orden cuando no hay asignación del proveedor; no es necesario para el flujo automático solicitado.

## 5. Activa los envíos

Cuando hayas terminado la configuración, cambia en `.env`:

```dotenv
WHATSAPP_MODE=web
```

Ejecuta:

```powershell
npm start
```

Deja esa ventana abierta. Las nuevas citas de la web irán al grupo. El médico recibirá su recordatorio **15 minutos antes**, siempre que la cita esté confirmada, tenga asignación y su teléfono esté registrado. Puede cambiarse la anticipación con `REMINDER_MINUTES`.

Primero comprueba una cita de prueba acordada con el equipo. No se ha enviado ninguna desde la entrega. El QR solo autoriza WhatsApp: **sin conectar la fuente de citas no habrá avisos automáticos**.

## Si no funciona

- **Apareció `WhatsApp conectado` y después `r: r` en `getChats()`:** el selector ya se corrigió para no usar esa llamada. Ejecuta de nuevo `npm run connect`; conserva tu sesión. Si aún no se cargan grupos, abre el grupo en el teléfono, espera la sincronización y repite. No necesitas borrar `.data/whatsapp`.

- **No hay QR:** revisa si aparece “WhatsApp conectado”; una sesión ya guardada no necesita otro QR.
- **Chrome no abre:** comprueba la instalación; opcionalmente configura `CHROME_PATH` con la ruta completa de Chrome. No desactives la protección del navegador como solución genérica.
- **Grupo no aparece:** confirma que vinculaste el número que es miembro, espera a que sincronice y repite `npm run connect`.
- **Solo imprime simulaciones:** aún tienes `WHATSAPP_MODE=mock`. Cambia a `web` y reinicia.
- **No detecta citas de la web publicada:** una SQLite local no es la SQLite de Render. Revisa dónde se ejecutan los dos procesos.
- **No llega al médico:** falta asignación, un ID no coincide con `doctors`, la consulta no está en la ventana de 15 minutos o la API de MediConecta falló. Revisa `/status` y `/health`.
- **Sesión desvinculada:** detén el bot y ejecuta de nuevo `npm run connect`. Si WhatsApp revocó la sesión, autorízala de nuevo en tu teléfono.
- **Mensaje sobre `worker.lock`:** evita abrir dos procesos. Si el anterior terminó abruptamente, confirma que está cerrado antes de borrar `.data/worker.lock`.

Para desconectar definitivamente, detén el bot y elimina el dispositivo correspondiente desde WhatsApp → Dispositivos vinculados. Conserva `.env`, `config.local.json` y `.data` en privado.

Referencia técnica: [autenticación y persistencia con LocalAuth](https://wwebjs.dev/guide/creating-your-bot/authentication).
