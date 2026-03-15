import { type CopilotSettings } from "@/settings/model";
import { logError, logWarn } from "@/logger";
import { Buffer } from "buffer";
import { Platform } from "obsidian";

// @ts-ignore
let safeStorageInternal: Electron.SafeStorage | null = null;

/**
 * Safely get Electron `safeStorage` when available.
 *
 * @returns The Electron safeStorage instance, or `null` when unavailable.
 */
function getSafeStorage() {
  // Reason: the rest of the codebase uses isDesktopApp; accept either
  // to stay compatible across Obsidian builds.
  if (!Platform.isDesktopApp && !Platform.isDesktop) return null;
  if (safeStorageInternal) return safeStorageInternal;
  try {
    // Dynamically import electron to access safeStorage
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    safeStorageInternal = require("electron")?.remote?.safeStorage ?? null;
    return safeStorageInternal;
  } catch {
    return null;
  }
}

// Prefixes to distinguish encryption methods
const DESKTOP_PREFIX = "enc_desk_";
const WEBCRYPTO_PREFIX = "enc_web_";
// Keep old prefix for backward compatibility
const ENCRYPTION_PREFIX = "enc_";
const DECRYPTION_PREFIX = "dec_";

/**
 * @deprecated getDecryptedKey() now returns "" on failure instead of this sentinel.
 * Kept only for backward compatibility with code that may still reference it.
 */
export const DECRYPTION_FAILURE_MESSAGE = "Copilot failed to decrypt API keys!";

/**
 * Check whether a value looks like an encrypted Copilot secret.
 *
 * Useful for UI code that needs to distinguish "user hasn't set a key" (empty)
 * from "decryption failed on this device" (was encrypted, decrypted to "").
 */
export function isEncryptedValue(value: string): boolean {
  if (value.startsWith(DESKTOP_PREFIX)) {
    return looksLikeBase64(value.slice(DESKTOP_PREFIX.length));
  }
  if (value.startsWith(WEBCRYPTO_PREFIX)) {
    return looksLikeBase64(value.slice(WEBCRYPTO_PREFIX.length));
  }
  if (value.startsWith(ENCRYPTION_PREFIX)) {
    return looksLikeBase64(value.slice(ENCRYPTION_PREFIX.length));
  }
  return false;
}

/**
 * Check whether a string is plausibly base64-encoded ciphertext.
 *
 * Reason: prefix-only checks like `enc_` can collide with user input;
 * requiring base64-like structure after the prefix prevents accidental
 * "encrypted value" misclassification in UI fields.
 */
function looksLikeBase64(data: string): boolean {
  if (!data) return false;
  // Reason: base64 encodes 3 bytes per 4 chars; a remainder of 1 after
  // mod-4 is structurally invalid and cannot represent whole bytes.
  if (data.length % 4 === 1) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}

// ---------------------------------------------------------------------------
// WebCrypto: portable encryption with random IV
// ---------------------------------------------------------------------------

const WEBCRYPTO_IV_LENGTH = 12;
const WEBCRYPTO_KEY_STORAGE_KEY = "obsidian-copilot:webcrypto-key:v1";
/** Magic header for portable payloads (hardcoded key + random IV). */
const WEBCRYPTO_PORTABLE_MAGIC = new Uint8Array([0x43, 0x50, 0x30, 0x30]); // "CP00"
/** Magic header for legacy per-device payloads (kept for backward-compat decryption). */
const WEBCRYPTO_DEVICE_MAGIC = new Uint8Array([0x43, 0x50, 0x30, 0x31]); // "CP01"

/**
 * Portable AES-GCM key shared across all devices for cross-device vault sync.
 * Used by both CP00 encryption and decryption. NOT a per-device key.
 */
const PORTABLE_WEBCRYPTO_KEY_BYTES = new TextEncoder().encode("obsidian-copilot-v1");
// Legacy fixed-IV kept ONLY for backward-compatible decryption of pre-CP00 payloads.
const LEGACY_WEBCRYPTO_IV = new Uint8Array(WEBCRYPTO_IV_LENGTH);

/** Assert WebCrypto is available before attempting crypto operations. */
function assertWebCryptoAvailable(): void {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto API is not available in this environment.");
  }
}

/**
 * Safely access `localStorage` in environments where the getter may throw
 * (e.g., sandboxed iframes, some mobile contexts).
 */
function getLocalStorageSafe(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Read an existing per-device AES-256 key from localStorage.
 *
 * Reason: kept for backward-compat decryption of CP01 payloads created by
 * earlier versions. New encryption always uses the portable CP00 format.
 */
async function getExistingWebCryptoKey(): Promise<CryptoKey | null> {
  try {
    const storage = getLocalStorageSafe();
    if (!storage) return null;
    const existing = storage.getItem(WEBCRYPTO_KEY_STORAGE_KEY);
    if (!existing) return null;
    const raw = base64ToArrayBuffer(existing);
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch (error) {
    logWarn("Failed to load WebCrypto key from localStorage.", error);
    return null;
  }
}

/**
 * Import the portable WebCrypto key for CP00 encryption/decryption
 * and legacy fixed-IV decryption.
 */
async function getPortableWebCryptoKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", PORTABLE_WEBCRYPTO_KEY_BYTES, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Check whether decoded WebCrypto payload begins with the provided magic header.
 */
function hasWebCryptoMagic(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Encrypt plaintext with WebCrypto using AES-GCM and a random IV.
 *
 * Output format (base64): [CP00(4)][IV(12)][CIPHERTEXT+TAG...]
 *
 * Reason: Copilot settings commonly sync across devices via the vault.
 * A portable (hardcoded) key preserves cross-device decryptability while
 * still providing at-rest obfuscation for the settings file.
 *
 * @returns Encrypted string with WEBCRYPTO_PREFIX.
 */
async function encryptWithWebCryptoV1(plaintext: string): Promise<string> {
  assertWebCryptoAvailable();
  const key = await getPortableWebCryptoKey();

  const iv = crypto.getRandomValues(new Uint8Array(WEBCRYPTO_IV_LENGTH));
  const encodedData = new TextEncoder().encode(plaintext);
  const encryptedData = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encodedData);

  // Reason: pack magic + IV + ciphertext into a single buffer so the IV
  // travels with the ciphertext and each encryption produces unique output.
  const encryptedBytes = new Uint8Array(encryptedData);
  const out = new Uint8Array(WEBCRYPTO_PORTABLE_MAGIC.length + iv.length + encryptedBytes.length);
  out.set(WEBCRYPTO_PORTABLE_MAGIC, 0);
  out.set(iv, WEBCRYPTO_PORTABLE_MAGIC.length);
  out.set(encryptedBytes, WEBCRYPTO_PORTABLE_MAGIC.length + iv.length);

  return WEBCRYPTO_PREFIX + arrayBufferToBase64(out.buffer);
}

/**
 * Decrypt a WEBCRYPTO_PREFIX value.
 * Supports portable CP00, legacy per-device CP01, and legacy fixed-IV formats.
 */
async function decryptWebCryptoValue(base64Data: string): Promise<string> {
  assertWebCryptoAvailable();
  const raw = new Uint8Array(base64ToArrayBuffer(base64Data));

  // Portable format: [CP00][IV][CIPHERTEXT] — portable key + random IV (current default)
  // Reason: once magic header matches, this IS the format — don't fallthrough on failure,
  // as corrupted CP00 data cannot be decoded by CP01/legacy and would produce misleading errors.
  if (hasWebCryptoMagic(raw, WEBCRYPTO_PORTABLE_MAGIC)) {
    const ivStart = WEBCRYPTO_PORTABLE_MAGIC.length;
    const ivEnd = ivStart + WEBCRYPTO_IV_LENGTH;
    if (raw.length <= ivEnd) throw new Error("Invalid WebCrypto portable payload: too short.");

    const iv = raw.slice(ivStart, ivEnd);
    const ciphertext = raw.slice(ivEnd);
    const key = await getPortableWebCryptoKey();
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  }

  // Legacy per-device format: [CP01][IV][CIPHERTEXT] — decrypt-only backward compat
  if (hasWebCryptoMagic(raw, WEBCRYPTO_DEVICE_MAGIC)) {
    const ivStart = WEBCRYPTO_DEVICE_MAGIC.length;
    const ivEnd = ivStart + WEBCRYPTO_IV_LENGTH;
    if (raw.length <= ivEnd) throw new Error("Invalid WebCrypto CP01 payload: too short.");

    const iv = raw.slice(ivStart, ivEnd);
    const ciphertext = raw.slice(ivEnd);
    const key = await getExistingWebCryptoKey();
    if (!key) throw new Error("Per-device WebCrypto key unavailable for CP01 decryption.");

    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  }

  // Legacy format: ciphertext only, fixed IV + hardcoded key (decrypt-only)
  const key = await getPortableWebCryptoKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: LEGACY_WEBCRYPTO_IV },
    key,
    base64ToArrayBuffer(base64Data)
  );
  return new TextDecoder().decode(decrypted);
}

/**
 * Check whether a top-level settings key holds a sensitive value
 * (API key, token, or license key) that requires encryption at rest.
 *
 * This is the single source of truth for sensitive field identification,
 * used by both encryption-at-rest and Setup URI export/import.
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  // Reason: normalize separators only for the "apikey" check so that
  // "api_key" and "api-key" variants are caught without broadening
  // other patterns (e.g., "maxTokens" must NOT match "token").
  const normalized = lower.replace(/[_-]/g, "");
  return (
    normalized.includes("apikey") ||
    lower.endsWith("token") ||
    lower.endsWith("accesstoken") ||
    lower.endsWith("secret") ||
    lower.endsWith("password") ||
    lower.endsWith("licensekey") ||
    lower === "openaiorgid"
  );
}

/**
 * Recursively encrypt all sensitive string values in a settings-like object.
 *
 * Reason: settings may contain encrypted API keys at any nesting depth
 * (e.g., providerConfigs.openai.apiKey). Instead of manually listing
 * each location, we walk the tree — mirroring `decryptSensitiveForExport`.
 */
async function encryptSensitiveValues(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) {
    return await Promise.all(value.map((item) => encryptSensitiveValues(item)));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(obj)) {
    if (isSensitiveKey(key) && typeof nested === "string" && nested) {
      out[key] = await getEncryptedKey(nested);
      continue;
    }

    out[key] = await encryptSensitiveValues(nested);
  }

  return out;
}

export async function encryptAllKeys(
  settings: Readonly<CopilotSettings>
): Promise<Readonly<CopilotSettings>> {
  if (!settings.enableEncryption) {
    return settings;
  }

  // Recursively encrypt all sensitive fields at any nesting depth
  return (await encryptSensitiveValues(settings)) as Readonly<CopilotSettings>;
}

export async function getEncryptedKey(apiKey: string): Promise<string> {
  if (!apiKey) return apiKey;

  // Reason: use isEncryptedValue() (prefix + base64 structure validation) to
  // avoid treating plaintext that happens to start with "enc_*" as already
  // encrypted. This ensures only genuine ciphertext is skipped.
  if (isEncryptedValue(apiKey)) return apiKey;

  if (isDecrypted(apiKey)) {
    apiKey = apiKey.replace(DECRYPTION_PREFIX, "");
  }

  try {

    // Try desktop encryption first
    if (getSafeStorage()?.isEncryptionAvailable()) {
      const encryptedBuffer = getSafeStorage()!.encryptString(apiKey) as Buffer;
      return DESKTOP_PREFIX + encryptedBuffer.toString("base64");
    }

    // Fallback to Web Crypto API (portable key, random IV)
    return await encryptWithWebCryptoV1(apiKey);
  } catch (error) {
    logError("Encryption failed:", error);
    // Reason: returning plaintext here would silently write secrets to disk
    // when the user has explicitly enabled encryption. Throw instead so the
    // caller can decide how to handle (e.g., skip saving, notify user).
    throw new Error(
      "Copilot failed to encrypt a sensitive value. Refusing to write plaintext to disk."
    );
  }
}

export async function getDecryptedKey(apiKey: string): Promise<string> {
  try {
    if (!apiKey || isPlainText(apiKey)) {
      return apiKey;
    }
    if (isDecrypted(apiKey)) {
      return apiKey.replace(DECRYPTION_PREFIX, "");
    }

    // Handle different encryption methods
    if (apiKey.startsWith(DESKTOP_PREFIX)) {
      const safeStorage = getSafeStorage();
      if (!safeStorage?.isEncryptionAvailable()) {
        // Reason: desktop-encrypted key opened on mobile — can't decrypt.
        // Return "" so callers (API providers) get an auth error rather than
        // sending an internal string over the network.
        logWarn("Cannot decrypt desktop-encrypted key: safeStorage unavailable (mobile/different device).");
        return "";
      }
      const base64Data = apiKey.replace(DESKTOP_PREFIX, "");
      const buffer = Buffer.from(base64Data, "base64");
      return safeStorage.decryptString(buffer) as string;
    }

    if (apiKey.startsWith(WEBCRYPTO_PREFIX)) {
      const base64Data = apiKey.replace(WEBCRYPTO_PREFIX, "");
      return await decryptWebCryptoValue(base64Data);
    }

    // Legacy support for old enc_ prefix
    const base64Data = apiKey.replace(ENCRYPTION_PREFIX, "");
    // Try desktop decryption first
    if (getSafeStorage()?.isEncryptionAvailable()) {
      try {
        const buffer = Buffer.from(base64Data, "base64");
        return getSafeStorage()!.decryptString(buffer) as string;
      } catch {
        // Silent catch is intentional - if desktop decryption fails,
        // it means this key was likely encrypted with Web Crypto.
        // We'll fall through to WebCrypto decryption below.
      }
    }

    // Fallback to legacy WebCrypto decryption for old enc_ values
    return await decryptWebCryptoValue(base64Data);
  } catch (err) {
    logError("Decryption failed:", err);
    // Reason: returning "" ensures callers (LLM providers) get an
    // authentication error rather than sending an internal string as
    // a bearer token over the network.
    return "";
  }
}

/**
 * Decrypt an API key and throw when decryption fails.
 *
 * Use this in workflows that must not proceed with an undecryptable
 * value (e.g., exporting cross-vault configuration via Setup URI).
 *
 * @param apiKey - Possibly encrypted API key value.
 * @returns Decrypted plaintext API key.
 * @throws {Error} When decryption fails (returns empty string).
 */
export async function getDecryptedKeyOrThrow(apiKey: string): Promise<string> {
  const decrypted = await getDecryptedKey(apiKey);
  if (!decrypted) {
    throw new Error("Failed to decrypt API key.");
  }
  return decrypted;
}

function isPlainText(key: string): boolean {
  return !key.startsWith(ENCRYPTION_PREFIX) && !key.startsWith(DECRYPTION_PREFIX);
}

function isDecrypted(keyBuffer: string): boolean {
  return keyBuffer.startsWith(DECRYPTION_PREFIX);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = globalThis.atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
