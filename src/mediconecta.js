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

  // MediConecta keeps the manual payment flag in HistoriaClinica.pagado.
  // It may promote the VIP payment to approved, but never downgrade a payment
  // that was already verified by Wompi in the VIP backend.
  if (mapping.paymentPath) {
    const providerPayment = field(data, mapping.paymentPath);
    const approvedValues = mapping.paymentApprovedValues || [true, 1, 'true', 'PAGADO', 'Pagado', 'pagado'];
    if (approvedValues.some(value => value === providerPayment)) result.payment = 'approved';
  }
  return result;
}
export function mediconecta(config, routes, env = process.env, fetcher = fetch) {
  if (env.MEDICONNECTA_LOOKUP !== 'true') return null;
  const authMode = env.MEDICONNECTA_AUTH_MODE || 'bearer';
  if (!['public', 'bearer'].includes(authMode)) throw new Error('MEDICONNECTA_AUTH_MODE inválido');
  if ((authMode === 'bearer' && !env.MEDICONNECTA_TOKEN) || !routes.mediconecta?.doctorIdPath) throw new Error('Configura el acceso a MediConecta y mediconecta.doctorIdPath antes de activar la consulta');
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
      const result = providerFields(body.data, routes.mediconecta);
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
