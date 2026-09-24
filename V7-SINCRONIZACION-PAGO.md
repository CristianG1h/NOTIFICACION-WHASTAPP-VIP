# V7 — Sincronización bidireccional de pago

Esta versión corrige el caso Pagado -> No pagado.

- `pagado=true`, `1` o `PAGADO` => `Pago: Pagado`.
- `pagado=false`, `0` o `NO PAGADO` => `Pago: Pendiente de verificación manual`.
- Si MediConecta falla temporalmente o no devuelve el campo, se conserva un pago ya aprobado para evitar falsos retrocesos.
- Un cambio explícito de pago genera una `Actualización de cita` por WhatsApp.

No cambia Baileys, MongoDB, el grupo ni el número del médico.
