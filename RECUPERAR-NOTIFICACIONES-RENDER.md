# Recuperar notificaciones WhatsApp en Render

Los errores `Persistencia/bloqueo no disponible` indican que el bot no puede
confirmar que posee el bloqueo de MongoDB. Por seguridad se suspenden los
envíos: mantener WhatsApp conectado no es suficiente. Un error `MediConecta ...`
es diferente: impide verificar la orden indicada y, por tanto, notificar a sus
médicos hasta que se restaure la consulta.

## 1. Revisar MongoDB Atlas (primero)

1. En MongoDB Atlas, confirmar que el clúster está **activo** y no pausado.
2. Revisar **Database Access**: el usuario de la URI debe existir y tener
   permisos de lectura/escritura en la base de datos del bot.
3. Revisar **Network Access**: las IP de salida del servicio Render deben poder
   conectarse al clúster. Evitar acceso abierto a Internet salvo que sea una
   decisión consciente y temporal; usar credenciales seguras.
4. En **Render > vip-notificaciones > Environment**, comprobar la existencia de
   `MONGODB_URI`, `MONGODB_DB` (si se usa) y `BAILEYS_SESSION_ID`.
   **No** borrar ni regenerar por rutina `MONGODB_URI`, `DATA_KEY`,
   `BAILEYS_SESSION_ID` ni la colección `baileys_auth`: pueden contener el estado
   necesario para reconectar sin escanear otro QR.
5. Si se corrige alguna variable, usar **Save and deploy**. Si únicamente
   Atlas estaba pausado, reanudar el clúster y esperar unos segundos;
   la versión corregida vuelve a intentar adquirir el bloqueo automáticamente.

## 2. Revisar el estado del servicio

Abrir `https://TU-SERVICIO.onrender.com/health`. Verificar:

- `persistenceHealthy: true`: MongoDB permite renovar el bloqueo.
- `whatsappReady: true`: WhatsApp está conectado.
- `sourceHealthy: true`: la API de citas VIP responde correctamente.
- `providerHealthy: true`: no fallaron consultas a MediConecta de órdenes activas.
- `notificationsReady: true`: todas las dependencias necesarias están disponibles.

Para ver el QR y comprobar los grupos, abrir
`https://TU-SERVICIO.onrender.com/admin/whatsapp` e introducir `API_TOKEN`.
Solo volver a vincular el número si el estado indica que la sesión se cerró;
una caída de MongoDB **no** requiere desvincular WhatsApp.

Confirmar que `CONTROL_GROUP_ID` contiene el ID real del grupo y que el número
del bot sigue siendo miembro. Los médicos se administran con el menú `MEDICO`
desde los números autorizados.

## 3. Si sigue apareciendo «MediConecta ...»

El log incluye ahora el código HTTP cuando la consulta de la orden falla:

- **401/403:** revisar `MEDICONNECTA_AUTH_MODE` y `MEDICONNECTA_TOKEN`
  con el operador de la API. No compartir el token por chat ni subirlo a GitHub.
- **404:** confirmar con MediConecta que `/api/ordenes/{id}` existe y que el
  identificador entregado por VIP corresponde a una orden de MediConecta.
- **5xx / timeout:** revisar disponibilidad de la API de MediConecta.

Confirmar `MEDICONNECTA_BASE_URL`, que por defecto es
`https://vip-mediconecta.app`. No desactivar la validación para forzar envíos
de pacientes a médicos no verificados. Si una sola orden falla, la versión
corregida permite que continúen los recordatorios de las demás órdenes válidas.

## 4. Prueba de extremo a extremo

1. En `/health`, comprobar primero MongoDB y WhatsApp.
2. Crear una **cita ficticia** próxima desde el flujo de pruebas autorizado.
3. Verificar el aviso al grupo y luego el recordatorio al médico asignado.
4. Si falta el aviso, revisar en Render `Logs` los mensajes `delivery_failed`,
   `MediConecta`, `Persistencia/bloqueo` o `WhatsApp desconectado`.

No publicar capturas que muestren pacientes, números, cadenas de conexión,
`API_TOKEN` o claves de cifrado.
