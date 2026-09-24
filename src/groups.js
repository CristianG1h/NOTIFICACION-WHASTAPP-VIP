export function normalizeBaileysGroups(metadata) {
  return Object.values(metadata || {})
    .filter(group => group && typeof group.id === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(group.id))
    .map(group => ({ id: group.id, name: String(group.subject || group.name || group.id) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function listGroups(socket) {
  if (!socket?.groupFetchAllParticipating) throw new Error('WhatsApp aún no está listo para consultar grupos.');
  const metadata = await socket.groupFetchAllParticipating();
  const groups = normalizeBaileysGroups(metadata);
  if (!groups.length) throw new Error('WhatsApp está conectado, pero no se encontraron grupos participantes. Abre el grupo en tu teléfono y vuelve a intentar.');
  return groups;
}
