import {
  GENERATED_ID_ALPHABET,
  GENERATED_ID_SUFFIX_LENGTH,
} from "../contract/domain/raw-thread-id.js";

/**
 * Ported from bb `packages/db/src/ids.ts` (commit 8473d8c33). bb uses nanoid's
 * customAlphabet; the alphabet/length constants are the domain ones, so the
 * generator below is byte-compatible with bb ids. Uses WebCrypto instead of
 * nanoid to stay Workers-native.
 */
const ALPHABET = GENERATED_ID_ALPHABET;
const SUFFIX_LENGTH = GENERATED_ID_SUFFIX_LENGTH;

function createId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH));
  let suffix = "";
  for (const byte of bytes) {
    suffix += ALPHABET.charAt(byte % ALPHABET.length);
  }
  return `${prefix}_${suffix}`;
}

export function createHostId(): string {
  return createId("host");
}

export function createProjectId(): string {
  return createId("proj");
}

export function createThreadId(): string {
  return createId("thr");
}

export function createThreadSectionId(): string {
  return createId("sec");
}

export function createEventId(): string {
  return createId("evt");
}

export function createHostDaemonSessionId(): string {
  return createId("hses");
}
