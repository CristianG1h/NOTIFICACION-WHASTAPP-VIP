// Only IDs/titles are needed. getChats() serializes every chat and refreshes
// group participants, which currently fails on some WhatsApp Web WID objects.
export function readGroupSummaries() {
  const collection = window.require('WAWebCollections').Chat;
  const groups = [];
  for (const chat of collection.getModelsArray()) {
    try {
      const id = chat.id?._serialized || chat.id?.$1;
      if (typeof id !== 'string' || !/^\d+(?:-\d+)?@g\.us$/.test(id)) continue;
      groups.push({ id: { _serialized: id }, name: String(chat.formattedTitle || chat.name || chat.groupMetadata?.subject || id), isGroup: true });
    } catch { /* A malformed unrelated chat must not block the group picker. */ }
  }
  return groups;
}
export async function listGroups(client, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const groups = await client.pupPage.evaluate(readGroupSummaries);
      if (groups.length) return groups;
    } catch { /* The client can emit ready before all chat modules synchronize. */ }
    if (attempt < 4) await sleep(2000);
  }
  throw new Error('La sesión está vinculada, pero no se pudieron cargar los grupos. Abre el grupo en tu teléfono, espera a que sincronice y repite npm run connect. No borres la sesión.');
}
