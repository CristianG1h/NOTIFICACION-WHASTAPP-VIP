# Médicos, confirmaciones y medios de pago

## Cómo usarlo

Con `npm start` activo y WhatsApp vinculado, escribir **MEDICO**, **MÉDICOS** o **MENU** desde uno de estos administradores:

- 573102210461
- 573212340504

Se muestran todos los médicos numerados y, al final, **Agregar médico**. Con un médico guardado, agregar será la opción 2; con dos, será la opción 3. Seleccionar un médico abre **1. Modificar**, **2. Eliminar**, **0. Volver**. Eliminar requiere escribir **ELIMINAR**, para evitar borrados por una selección accidental. **CANCELAR** cierra el menú y una sesión sin uso vence a los 10 minutos.

Agregar/modificar pide nombre y celular colombiano. Se aceptan `3001234567`, `+57 300 123 4567` y `573001234567`: se guardan como `573001234567`. No se aceptan números incompletos, duplicados ni varios celulares en un campo; se agrega cada médico por separado. Los IDs internos permanecen estables al editar, pero nunca se piden al administrador.

Solo los dos números indicados administran. Los médicos guardados pueden contestar sus solicitudes de atención. Otros remitentes no reciben respuesta, y no se procesan mensajes de grupos, mensajes propios, historial sincronizado ni mensajes con más de 10 minutos de antigüedad.

## Notificaciones

| Destino | Qué recibe |
| --- | --- |
| Grupo configurado | Nueva cita y cambio real de fecha/hora |
| Todos los médicos guardados | Recordatorio dentro de los 15 minutos anteriores, con nombre, fecha/hora Colombia, pago, formulario y panel |
| Médico que confirma | Confirmación y aviso al inicio de la consulta |
| Otros médicos | Aviso personalizado indicando quién confirmó y agradeciendo estar pendientes de nuevas teleconsultas |

Cambiar pago, formulario, nombre, médico o estado sin cambiar el horario actualiza el registro, pero no produce otro mensaje al grupo. Las cancelaciones y consultas atendidas detienen los recordatorios. Los estados no verificados se muestran como tales.

En una solicitud, **1** confirma y **2** registra indisponibilidad de ese médico. Cuando hay varias citas pendientes se exige el código incluido en el aviso, por ejemplo `1 A123B456C789`. La primera confirmación válida se registra en una transacción; otra respuesta no puede reemplazarla. Al reprogramar se invalida la solicitud anterior. La confirmación registra cobertura en este bot; no modifica automáticamente la asignación clínica en la plataforma externa.

El aviso de inicio sale en el primer ciclo a partir de la hora programada. Con `POLL_SECONDS=15`, la precisión normal es la del ciclo más el tiempo de consulta y envío; no es una garantía al segundo. Hay una ventana de recuperación de 2 minutos. Una vez vencida no se envía un aviso atrasado. Si nadie confirma, el aviso de inicio llega a los médicos que no hayan rechazado.

Antes de programar avisos se sincroniza la fuente. El mensaje se reconstruye con el registro más reciente antes de enviarlo. Si la fuente falla, se suspenden los recordatorios hasta recuperar datos; los menús siguen funcionando. Un fallo específico al verificar el formulario se muestra como “Sin verificar”, sin inventar que está completado.

## Migración y persistencia

1. Conservar **DATA_KEY**, **API_TOKEN**, **VIP_API_TOKEN**, **MONGODB_URI** y **BAILEYS_SESSION_ID** de la instalación actual. Cambiar DATA_KEY impide leer los registros cifrados.
2. Subir esta versión y su `package-lock.json`. El build usa `npm ci`.
3. Ya no es obligatorio configurar DOCTOR_PHONE ni DOCTOR_ID. Si existen, sirven como configuración inicial hasta guardar el directorio por WhatsApp. Una vez administrado, el directorio persistido tiene prioridad y todas sus entradas reciben solicitudes, sin depender de claves de médico de MediConecta.
4. Mantener `CONTROL_GROUP_ID` si está definido. Si se guarda desde el panel, también queda en la copia del estado de MongoDB.
5. Usar un solo servicio por sesión. Un bloqueo renovable en MongoDB evita que dos workers de esta versión envíen con la misma sesión. Al detenerse abruptamente, el bloqueo vence en aproximadamente 90 segundos; un redeploy que encuentre el bloqueo debe reintentarse después.

MongoDB guarda, cifrados con DATA_KEY, el directorio y copias de citas, cola, confirmaciones y registros de deduplicación. Las copias se publican mediante un manifiesto atómico, dividido en bloques para evitar el límite de tamaño de un documento. Si falla una copia no se reemplaza la anterior. Sin MONGODB_URI se usa SQLite local: en discos temporales de Render esos datos se pierden al redeployar.

La entrega de WhatsApp y el guardado en la base son operaciones separadas: una caída justo después de aceptar WhatsApp el mensaje y antes de guardar su resultado todavía puede causar una repetición. No se promete entrega exactamente una vez. La persistencia reduce las repeticiones por reinicios normales y el bloqueo evita workers concurrentes.

Los avisos antiguos de tipo “actualización” que estaban pendientes al actualizar se cancelan para no enviar una acumulación de cambios de pago/formulario. Se preservan los registros de recordatorios ya enviados. En una instalación vacía, la fuente vip-api conserva el comportamiento de anunciar las citas futuras encontradas inicialmente; no reproduce citas históricas pasadas.

## QR y diseño de pagos

- `public/payments/index.html`: página adaptable a móvil con botones para copiar, QR y los medios de la captura.
- `public/payments/qr-vip.svg`: QR vectorial limpio, con margen de cuatro módulos y sin adornos encima del código.
- `output/payments/medios-de-pago-vip.png`: imagen para compartir.
- `output/payments/medios-de-pago-vip-movil.png`: versión vertical.
- `output/payments/verificacion-qr.json`: comprobación de lectura de ambas imágenes.

Se decodificó el PDF aportado y se regeneró el QR conservando exactamente sus **528 bytes**. Se leyeron las dos imágenes finales y se verificó su igualdad byte por byte con el contenido original. No se hizo una transacción bancaria; la comprobación acredita el mismo contenido escaneable, no la disponibilidad del banco. Las cuentas y llaves se transcribieron de la captura. Wompi permanece indicado como temporalmente no disponible.

La página original de pagos no está en esta carpeta. Para integrarlo allí se necesita su repositorio o ruta: este componente y las imágenes ya están preparados, pero no están publicados ni sustituyen todavía esa página.

## Verificación

Ejecutar `npm test`. Las pruebas usan datos ficticios y transporte simulado: autorizaciones, celulares, alta/edición/baja, persistencia, bloqueo de dos workers, fallos de guardado, doble confirmación, múltiples citas, rechazo, reprogramación, cancelación, avisos selectivos y horarios. No se envían mensajes reales en estas pruebas.

La verificación del diseño comprueba lectura del QR de las imágenes finales, vista móvil sin desplazamiento horizontal y revisión visual. Sigue pendiente comprobar la conexión del entorno real, usando sus credenciales y un envío de prueba expresamente solicitado.
