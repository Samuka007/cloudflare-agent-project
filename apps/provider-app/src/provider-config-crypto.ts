/**
 * #362 provider-config credential encryption — AES-256-GCM over the D1
 * `provider_configs.api_key_enc` column, WebCrypto-native (workerd
 * `crypto.subtle`, no Node APIs).
 *
 * Key material: the `PROVIDER_CONFIG_MASTER_KEY` Worker secret. The raw
 * secret string is never used as the AES key directly — SHA-256 derives a
 * 32-byte key so arbitrary-length secrets work. Payload format:
 * `base64(iv[12] || ciphertext+tag)` — a fresh random IV per encryption, so
 * re-encrypting the same key never produces the same column value (rotation
 * writes are always observable diffs).
 *
 * Zero-secret discipline: the plaintext exists only inside the calling
 * request/refresh scope; no log, projection, or snapshot ever receives it.
 */

const IV_BYTES = 12;
const ALGORITHM = "AES-GCM";

async function deriveAesKey(masterKey: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(masterKey),
  );
  return crypto.subtle.importKey("raw", digest, { name: ALGORITHM }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Encrypt one provider secret into the D1 column payload format. */
export async function encryptProviderSecret(
  masterKey: string,
  plaintext: string,
): Promise<string> {
  const key = await deriveAesKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const payload = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(ciphertext), IV_BYTES);
  return toBase64(payload);
}

/**
 * Decrypt one `api_key_enc` column value. Throws on tampered/foreign
 * payloads (bad base64, short IV, auth-tag mismatch) — callers surface that
 * as a per-row warning and ride the mock-first degradation, never a partial
 * key.
 */
export async function decryptProviderSecret(
  masterKey: string,
  payload: string,
): Promise<string> {
  const bytes = fromBase64(payload);
  if (bytes.length <= IV_BYTES) {
    throw new Error("provider secret payload is truncated");
  }
  const key = await deriveAesKey(masterKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: bytes.slice(0, IV_BYTES) },
    key,
    bytes.slice(IV_BYTES),
  );
  return new TextDecoder().decode(plaintext);
}
