// Guarda os áudios enviados (app, Telegram, WhatsApp) por 7 dias no Storage do Supabase,
// para a pessoa poder ouvir de novo e conferir a transcrição. Pasta = id da pessoa.

export interface AudioStore {
  save(userId: string, bytes: Uint8Array, mime: string): Promise<string | undefined>;
}

const EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/aac": "aac", "audio/wav": "wav", "audio/x-m4a": "m4a" };
const KEEP_DAYS = 7;

export function supabaseAudioStore(url: string, serviceKey: string, f: typeof fetch = fetch): AudioStore {
  const base = `${url}/storage/v1/object`;
  const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };

  /** Apaga os áudios da pessoa com mais de 7 dias (roda junto com um envio, sem atrasar a resposta). */
  async function cleanup(userId: string) {
    try {
      const r = await f(`${base}/list/audios`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ prefix: `${userId}/`, limit: 200, sortBy: { column: "created_at", order: "asc" } }),
      });
      if (!r.ok) return;
      const limit = Date.now() - KEEP_DAYS * 86400_000;
      const old = ((await r.json()) as any[]).filter((o) => o.name && o.created_at && Date.parse(o.created_at) < limit).map((o) => `${userId}/${o.name}`);
      if (old.length) await f(`${base}/audios`, { method: "DELETE", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ prefixes: old }) });
    } catch { /* limpeza é opcional */ }
  }

  return {
    async save(userId, bytes, mime) {
      const type = (mime || "audio/webm").split(";")[0].toLowerCase();
      const path = `${userId}/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.${EXT[type] ?? "webm"}`;
      try {
        const r = await f(`${base}/audios/${path}`, { method: "POST", headers: { ...headers, "content-type": type, "x-upsert": "false" }, body: bytes as unknown as BodyInit });
        if (!r.ok) { console.warn("áudio não salvo:", r.status, (await r.text()).slice(0, 120)); return undefined; }
        cleanup(userId);
        return path;
      } catch (e) {
        console.warn("áudio não salvo:", (e as Error).message);
        return undefined;
      }
    },
  };
}
