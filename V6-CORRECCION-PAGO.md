# V6 - corrección de pago manual

Esta versión conserva Baileys + MongoDB y reactiva la lectura del campo `pagado` de MediConecta.

## Render Environment

Configura:

```text
MEDICONNECTA_LOOKUP=true
MEDICONNECTA_AUTH_MODE=public
MEDICONNECTA_PAYMENT_PATH=pagado
```

Si el despliegue de MediConecta exige Bearer, usa en cambio:

```text
MEDICONNECTA_AUTH_MODE=bearer
MEDICONNECTA_TOKEN=TOKEN_AUTORIZADO
```

No cambies `MONGODB_URI`, `BAILEYS_SESSION_ID`, `DOCTOR_PHONE`, `CONTROL_GROUP_ID`, `VIP_API_TOKEN`, `API_TOKEN` ni `DATA_KEY`.

## Comportamiento esperado

- `pagado=true` -> `Pago: Pagado`.
- Un pago ya `approved` no vuelve a `manual_pending` por un fallo temporal de MediConecta.
- Un estado terminal explícito del backend (por ejemplo `voided` o `declined`) sigue respetándose.
- Baileys y la sesión MongoDB no cambian.
