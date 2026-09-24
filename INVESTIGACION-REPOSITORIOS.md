# Hallazgos en los repositorios del creador

Revisión del 24 de septiembre de 2026. Solo código público; no se hicieron llamadas a órdenes de pacientes ni se utilizaron credenciales encontradas en repositorios. La presencia de un endpoint en GitHub no demuestra que la misma versión esté desplegada en `vip-mediconecta.app`.

## Fuente principal: BSL-PLATAFORMA

Revisión fijada a commit `8a95c270e8499c7727ffc5f6cad0c333743d05dc`.

| Información | Ruta/campo hallado | Evidencia |
| --- | --- | --- |
| Crear orden | `POST /api/ordenes` | [server.js:6299](https://github.com/dtalero78/BSL-PLATAFORMA/blob/8a95c270e8499c7727ffc5f6cad0c333743d05dc/server.js#L6299) |
| Asignación automática | Guarda `medico` como `alias` o `primer_nombre + primer_apellido`, no necesariamente ID numérico | [server.js:6366](https://github.com/dtalero78/BSL-PLATAFORMA/blob/8a95c270e8499c7727ffc5f6cad0c333743d05dc/server.js#L6366) |
| Consulta de una orden | `GET /api/ordenes/:id` → `{success, data}`; lee HistoriaClinica por `_id` | [server.js:7735](https://github.com/dtalero78/BSL-PLATAFORMA/blob/8a95c270e8499c7727ffc5f6cad0c333743d05dc/server.js#L7735) |
| Listado de órdenes | `GET /api/ordenes`; filtros `codEmpresa`, `buscar`, `limit`, `offset`; usa middleware de autenticación | [server.js:7463](https://github.com/dtalero78/BSL-PLATAFORMA/blob/8a95c270e8499c7727ffc5f6cad0c333743d05dc/server.js#L7463) |
| Médicos activos | `GET /api/medicos` → `data[]` con `id`, nombres y `alias` | [server.js:9155](https://github.com/dtalero78/BSL-PLATAFORMA/blob/8a95c270e8499c7727ffc5f6cad0c333743d05dc/server.js#L9155) |
| Formulario de una orden | `GET /api/formularios/buscar/:identificador`; primero busca por `wix_id` | [server.js:5614](https://github.com/dtalero78/BSL-PLATAFORMA/blob/8a95c270e8499c7727ffc5f6cad0c333743d05dc/server.js#L5614) |

La consulta de orden devuelve campos como `medico`, `fechaAtencion`, `horaAtencion` y `atendido`. No se ha demostrado en esta revisión un estado Wompi equivalente al del backend VIP: los pagos del bot siguen viniendo de ese backend.

El buscador de formularios también hace búsquedas alternativas por documento. Por eso el adaptador solo acepta un resultado cuyo `data.wix_id` coincida exactamente con la orden solicitada. Encontrar un formulario guardado se informa como **Recibido (validación pendiente)**, no como formulario clínico completo.

## Cómo aprovecharlo sin depender de una SQLite compartida

La respuesta de creación ya proporciona el `_id` de la orden que el backend VIP conserva como `externalId`. Ese es el vínculo correcto:

```text
Web VIP crea orden → MediConecta devuelve _id
                 → backend comunica esa cita al bot
                 → consulta autenticada GET /api/ordenes/_id
                 → alias del médico → WhatsApp configurado
                 → consulta formulario ligado a esa misma orden
```

Esto permite una integración por API entre servidores separados. **Crear órdenes no equivale a recibir automáticamente sus cambios:** falta conectar el emisor del backend a `/events/appointment`, con reintentos, y hacer que el emisor consulte periódicamente médico/formulario. El modo webhook actual recibe snapshots; no sondea MediConecta solo. El modo SQLite ya incorpora el sondeo del proveedor. No se ha desplegado ni modificado el backend original en esta revisión.

No conviene importar indiscriminadamente `GET /api/ordenes`: `codEmpresa=PARTICULAR` no demuestra que una orden haya nacido en la web VIP. Usar los IDs devueltos por la creación conserva exactamente el alcance solicitado.

## Configuración del adaptador incluida

Se agregó `config.bsl-example.json` como perfil de referencia. **No sobrescribas `config.local.json`**, porque contiene el grupo elegido y tus teléfonos. Copia solo el bloque `mediconecta` después de comprobar que tu instancia tiene el mismo contrato.

Ejemplo ficticio:

```json
"doctors": { "doctor1": "573001234567" },
"mediconecta": {
  "doctorIdPath": "medico",
  "requireDoctorAlias": true,
  "doctorAliases": { "ALIAS EXACTO EN MEDICONECTA": "doctor1" },
  "formPath": "",
  "formValues": { "completed": [], "pending": [] },
  "formLookup": "bsl-wix-id"
}
```

Un alias no configurado bloquea el aviso a ese médico; no se manda al médico predeterminado. Mantén `MEDICONNECTA_TOKEN` en `.env` y activa `MEDICONNECTA_LOOKUP=true` solo con autorización de acceso. No se incorporaron credenciales del repositorio.

## Otros repositorios revisados

- [VIP-TELECONSULTA](https://github.com/dtalero78/VIP-TELECONSULTA): su versión pública incluye `backend/src/server/notifications.ts` con correo vía Brevo para creación y reprogramación. Es posterior/diferente de la copia local revisada al inicio. No es un emisor WhatsApp para este bot.
- [BSL-CONSULTAVIDEO](https://github.com/dtalero78/BSL-CONSULTAVIDEO), [panel-medico](https://github.com/dtalero78/panel-medico) y [mediconecta-consulta](https://github.com/dtalero78/mediconecta-consulta): contienen rutas de panel médico y videollamadas. El documento `PANEL-MEDICO.md` de BSL-CONSULTAVIDEO advierte sobre datos simulados; no se tomó ese panel como prueba de la API productiva.
- BRS y LGS2026 no aportaron en los archivos inspeccionados el contrato de órdenes que utiliza VIP.

## Error de WhatsApp de la captura

La sesión llegó a `ready`; el fallo ocurrió en `Client.getChats()`. Coincide con [el reporte de la biblioteca](https://github.com/wwebjs/whatsapp-web.js/issues/201845) y con una [corrección propuesta para cambios de WID](https://github.com/wwebjs/whatsapp-web.js/pull/201871).

Se sustituyó esa llamada por una lectura mínima de identificadores y títulos de grupos, compatible con `_serialized` y `$1`, sin serializar participantes. Añade reintentos de sincronización, captura del error y conservación del grupo antes de configurar médicos. No se modificó `node_modules`, no se borró la sesión y no se enviaron mensajes. La corrección está cubierta por pruebas simuladas; la comprobación con tu sesión se hace volviendo a ejecutar `npm run connect`.
