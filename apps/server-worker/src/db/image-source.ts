/**
 * #448 the image_source persistence: the single-row D1 seat (id =
 * 'image_source', the app_theme precedent) behind GET/PUT
 * /system/image-source. `provider_id` names the api=openai-images
 * provider_configs row that supplies generate_image; NULL = no selection —
 * the ONLY not-configured state (#450 zero-env ruling: D1 is the sole
 * 正本, no env fallback exists).
 */

/** The capability slice this module needs (the worker Env satisfies it). */
export interface ImageSourceEnv {
  DB?: D1Database;
}

const IMAGE_SOURCE_ROW_ID = "image_source";

export async function getImageSourceProviderId(env: ImageSourceEnv): Promise<string | null> {
  if (env.DB === undefined) return null;
  const row = await env.DB.prepare("SELECT provider_id FROM image_source WHERE id = ?")
    .bind(IMAGE_SOURCE_ROW_ID)
    .first<{ provider_id: string | null }>();
  return row?.provider_id ?? null;
}

/** Upsert the seat (null clears it); updated_at always moves. */
export async function setImageSourceProviderId(
  env: ImageSourceEnv,
  providerId: string | null,
): Promise<void> {
  if (env.DB === undefined) return;
  await env.DB.prepare(
    `INSERT INTO image_source (id, provider_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET provider_id = excluded.provider_id, updated_at = excluded.updated_at`,
  )
    .bind(IMAGE_SOURCE_ROW_ID, providerId, Date.now())
    .run();
}
