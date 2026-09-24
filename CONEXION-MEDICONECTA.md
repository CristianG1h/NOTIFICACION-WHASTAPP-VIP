# Investigación de la conexión VIP / MediConecta

**Actualización:** se encontraron los endpoints y el uso del alias del médico en repositorios del creador. Ver [INVESTIGACION-REPOSITORIOS.md](INVESTIGACION-REPOSITORIOS.md). Las incertidumbres descritas abajo corresponden a la revisión inicial; todavía falta verificar que esa versión pública coincida con el despliegue VIP.

Revisión: 24 de septiembre de 2026. Se examinó el código local y las páginas/scripts públicos indicados abajo. No se inició sesión en MediConecta, consultaron órdenes privadas ni hicieron escrituras en el proveedor.

## Lo confirmado en el código

En el proyecto vecino `VIP-TELECONSULTA-main`:

| Archivo | Hallazgo |
| --- | --- |
| `backend/src/server/mediconecta.ts` | Base por defecto `https://vip-mediconecta.app`; tenant esperado `ipsVip`. |
| mismo adaptador | Consulta configuración por `GET /api/tenants/config` y disponibilidad por `GET /api/turnos-disponibles`. |
| mismo adaptador | Crea órdenes con `POST /api/ordenes`; envía `medico: null` y `asignarMedicoAuto: true`. Por eso la web no conoce al médico al crear la cita. |
| mismo adaptador | Consulta una orden conocida mediante `GET /api/ordenes/:id`; espera `{ success: true, data: { _id, ... } }`. La estructura del médico en esa respuesta no está documentada aquí. |
| mismo adaptador | Reprograma mediante `PATCH /api/ordenes/:id/fecha-atencion`. |
| `backend/src/server/booking-service.ts` | Guarda el identificador de orden de MediConecta en `data.externalId`. |
| `backend/src/server/store.ts` | SQLite `requests.live.sqlite` / `requests.mock.sqlite`; carga JSON cifrada con AES-256-GCM, IV de 12 bytes, tag de 16 bytes y clave de 32 bytes. |
| `backend/src/server/payments.ts` | Verifica el webhook Wompi y consulta la transacción antes de guardar su estado. |
| `backend/src/server.ts` | El enlace de continuación es `https://vip-mediconecta.app/?_id=ID`. No existe un endpoint de listado administrativo de citas para un bot. |

El código local no guarda el teléfono ni identificador del médico asignado y no tiene un estado de formulario médico. Tampoco incluye un webhook de salida de notificaciones.

## Lo comprobado en el sitio público

- [Página principal](https://vip-mediconecta.app/): presenta inicio de sesión.
- [Script público de autenticación](https://vip-mediconecta.app/js/auth.js): implementa autenticación Bearer e inyección de `Authorization` en peticiones del mismo origen. Menciona `/api/auth/login`, `/api/auth/logout` y `/api/auth/verificar-token`.
- [Página pública de reserva](https://vip-mediconecta.app/nuevaorden1.html): contiene referencias a los endpoints de órdenes y disponibilidad utilizados por el adaptador.

Esto confirma el mecanismo visible de autenticación, **no** que un token concreto tenga permiso de consultar órdenes ni que sea permanente. No se encontraron credenciales ni un contrato público verificado para médico/formulario. No se ha probado la respuesta real de `/api/ordenes/:id`.

## Adaptación implementada

`src/bridge.js` abre la base VIP en modo de solo lectura, descifra únicamente para extraer referencia, hora y estados, y descarta los datos personales restantes. El bot no importa el código del backend ni escribe en su base.

`src/mediconecta.js`, cuando se activa, consulta por GET exclusivamente los IDs de órdenes conocidas originadas en la web VIP, con Bearer y HTTPS. Rechaza redirecciones y verifica que la respuesta corresponda al ID solicitado. No crea, reprograma ni cambia órdenes.

El pago sigue siendo el estado verificado por el backend VIP. El médico y formulario se leen de MediConecta a través de un mapeo configurable de campos. Si falla la consulta, el bot suspende el aviso al médico para esa cita y muestra formulario sin verificar; los avisos del grupo siguen funcionando.

## Qué debe proporcionar el administrador de MediConecta

1. Un token/cuenta autorizada para lectura de las órdenes de `ipsVip`, con información de expiración y renovación. Guardarlo en `.env` como `MEDICONNECTA_TOKEN`, no pegarlo en el chat.
2. Una respuesta de ejemplo **anonimizada** de `GET /api/ordenes/:id` que muestre la estructura del campo de médico y del estado del formulario.
3. La relación entre identificador de cada médico y su número de WhatsApp autorizado para estos avisos.
4. Confirmar que `/?_id=ID` conduce al contexto que debe abrir el médico con su sesión. Este es el enlace que ya usa la web; no se ha validado un enlace clínico alternativo.

Ejemplo **hipotético**, no confirmado: si `data` fuese

```json
{
  "_id": "ORDEN",
  "medico": { "_id": "MEDICO" },
  "formulario": { "estado": "COMPLETO" }
}
```

configurarías en `config.local.json`:

```json
"mediconecta": {
  "doctorIdPath": "medico._id",
  "formPath": "formulario.estado",
  "formValues": {
    "completed": ["COMPLETO"],
    "pending": ["PENDIENTE"]
  }
}
```

Las rutas se interpretan respecto a `data`, no al JSON exterior. Si el médico viene directamente como un ID de texto en `medico`, la ruta sería `medico`. Si el formulario viene de otro endpoint, hará falta adaptar ese lector: no se inventa ni se consulta una ruta desconocida. Los valores no reconocidos se muestran como sin verificar.

Activa finalmente `MEDICONNECTA_LOOKUP=true`. En modo SQLite, también se detectan cambios del médico/formulario del proveedor aunque la fila de VIP no cambie. Reinicia después de editar configuración o renovar el token.

## Despliegue pendiente

Hay dos conexiones independientes: vincular WhatsApp y acceder a la fuente real de citas. Para la implementación SQLite de esta entrega, ejecuta bot y backend en un entorno con el mismo disco accesible. Mantén una sola instancia del bot y almacenamiento persistente para base/sesión.

Si deben vivir en servidores aislados, el endpoint autenticado `/events/appointment` está preparado, pero falta instalar un emisor fiable en el lado del backend que envíe el snapshot junto con médico/formulario. Esto requiere un cambio o proceso adicional en el servidor original. No se ha realizado despliegue ni modificación del sitio existente.

No se reemplazó el webhook Wompi ni se reutilizó su secreto para el bot. No se ha construido un lector de todas las citas de MediConecta: el alcance son las originadas en la web VIP, conforme al flujo solicitado.
