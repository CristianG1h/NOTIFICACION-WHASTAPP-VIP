// The route and Bearer mechanism were found in the VIP adapter/public auth.js.
// Response field paths MUST be confirmed against an authorized provider response.
function field(data, path) {
  if (!path) return undefined;
  if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(path)) throw new Error('Ruta de campo inválida');
  return path.split('.').reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, data);
}
export function providerFields(data, mapping) {
  let doctor = field(data, mapping.doctorIdPath);
  if (doctor != null && Object.hasOwn(mapping.doctorAliases || {}, String(doctor))) doctor = mapping.doctorAliases[String(doctor)];
  else if (mapping.requireDoctorAlias && doctor != null) doctor = 'PROVIDER_UNAVAILABLE';
  if (doctor != null && (typeof doctor !== 'string' || !/^[\w-]{1,100}$/.test(doctor))) throw new Error('El campo de médico debe identificar un médico, no un objeto');
  const value = field(data, mapping.formPath);
  const form = value !== undefined && mapping.formValues?.completed?.includes(value) ? 'completed'
    : value !== undefined && mapping.formValues?.pending?.includes(value) ? 'pending' : 'unknown';
  const result = { doctorId: doctor || null, form };
  if (mapping.completedStatusValues?.includes(field(data, mapping.statusPath))) result.status = 'completed';

  // MediConecta is authoritative for the manual payment switch.
  // If the field is explicitly paid, promote to approved. If it is explicitly
  // unpaid, return to manual_pending so a real Pago -> No pagado change is
  // notified. If the field is absent/unknown, do not invent a payment state.
  if (mapping.paymentPath) {
    const providerPayment = field(data, mapping.paymentPath);
    const approvedValues = mapping.paymentApprovedValues || [true, 1, 'true', '1', 'PAGADO', 'Pagado', 'pagado'];
    const pendingValues = mapping.paymentPendingValues || [false, 0, 'false', '0', 'NO PAGADO', 'No pagado', 'no pagado', 'PENDIENTE', 'Pendiente', 'pendiente'];
    if (approvedValues.some(value => value === providerPayment)) result.payment = 'approved';
    else if (pendingValues.some(value => value === providerPayment)) result.payment = 'manual_pending';
  }
  return result;
}
export function mediconecta(config, routes, env = process.env, fetcher = fetch) {
  if (env.MEDICONNECTA_LOOKUP !== 'true') return null;
  const authMode = env.MEDICONNECTA_AUTH_MODE || 'public';
  if (!['public', 'bearer'].includes(authMode)) throw new Error('MEDICONNECTA_AUTH_MODE inválido');
  const mapping = routes.mediconecta || {};
  const hasReadableField = Boolean(mapping.doctorIdPath || mapping.paymentPath || mapping.statusPath || mapping.formLookup);
  if (authMode === 'bearer' && !env.MEDICONNECTA_TOKEN) throw new Error('MEDICONNECTA_AUTH_MODE=bearer requiere MEDICONNECTA_TOKEN');
  if (!hasReadableField) throw new Error('Configura al menos un campo de lectura de MediConecta antes de activar la consulta');
  const headers = { Accept: 'application/json', ...(env.MEDICONNECTA_TOKEN ? { Authorization: `Bearer ${env.MEDICONNECTA_TOKEN}` } : {}) };
  return {
    async lookup(id) {
      if (!/^[\w-]{1,100}$/.test(id)) throw new Error('ID inválido');
      const response = await fetcher(`${config.base}/api/ordenes/${encodeURIComponent(id)}`, {
        headers,
        redirect: 'error', signal: AbortSignal.timeout(12000), cache: 'no-store',
      });
      if (!response.ok) throw new Error('No se pudo consultar la orden en MediConecta');
      const body = await response.json();
      if (body.success !== true || body.data?._id !== id) throw new Error('Respuesta de orden no válida');
      // WhatsApp-managed rosters broadcast to saved phones, independently of a
      // provider's physician names/keys. Payment and form validation still apply.
      const result = providerFields(body.data, routes.broadcastDoctors ? { ...routes.mediconecta, doctorIdPath: '' } : routes.mediconecta);
      if (routes.mediconecta.formLookup === 'bsl-wix-id') {
        // This route can fall back to patient document searches on the provider.
        // Only accept an exact order link; never assume another form belongs here.
        try {
          const formResponse = await fetcher(`${config.base}/api/formularios/buscar/${encodeURIComponent(id)}`, {
            headers,
            redirect: 'error', signal: AbortSignal.timeout(12000), cache: 'no-store',
          });
          if (!formResponse.ok) throw new Error('Formulario no disponible');
          const form = await formResponse.json();
          result.form = form.success === true && form.data?.wix_id === id ? 'received' : 'unknown';
        } catch { result.form = 'unknown'; }
      }
      return result;
    },
  };
}
