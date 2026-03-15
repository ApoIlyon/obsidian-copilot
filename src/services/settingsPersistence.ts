import { type CopilotSettings, sanitizeSettings } from "@/settings/model";
import { encryptAllKeys } from "@/encryptionService";
import { KeychainService } from "@/services/keychainService";
import { logError, logInfo } from "@/logger";

/**
 * Write queue to serialize all persistence operations.
 *
 * Reason: The settings subscriber fires synchronously on every `setSettings()` call,
 * but keychain + data.json writes are async. Without serialization, rapid successive
 * `setSettings()` calls would cause concurrent writes with unpredictable ordering.
 */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Unified save path for all settings persistence.
 * Used by both the settings subscriber and Setup URI import.
 *
 * When keychain is available:
 * 1. Extract secrets from settings → get stripped settings + secret entries
 * 2. Write secrets to keychain FIRST (never clear data.json before keychain confirmed)
 * 3. Write stripped settings to data.json (with `_keychainMigrated: true`)
 *
 * When keychain is NOT available:
 * - Falls back to legacy encryption or plain save based on `enableEncryption`.
 *
 * This function is pure persistence — it NEVER calls `setSettings()` or modifies Jotai atoms.
 *
 * @param settings - The full settings object (with plaintext secrets in memory)
 * @param saveData - Callback to write data.json (typically `plugin.saveData`)
 * @param prevSettings - Previous settings for detecting deleted models
 */
export async function persistSettings(
  settings: CopilotSettings,
  saveData: (data: CopilotSettings) => Promise<void>,
  prevSettings?: CopilotSettings
): Promise<void> {
  // Reason: Chain onto writeQueue so concurrent calls are serialized.
  // Each call gets its own error propagation, but a single failure
  // doesn't block subsequent writes.
  const job = writeQueue.then(() => doPersist(settings, saveData, prevSettings));
  writeQueue = job.catch(() => {
    /* swallow to unblock next write */
  });
  return job;
}

/**
 * Unified load path for settings with keychain integration.
 *
 * Flow:
 * 1. Sanitize raw data (normalizes model providers, fills defaults)
 * 2. If keychain available and not yet migrated → run one-time migration
 * 3. If keychain available → hydrate secrets from keychain into memory
 * 4. If keychain NOT available → return as-is (legacy path)
 *
 * Returns hydrated settings. Does NOT call `setSettings()` — caller does that.
 *
 * @param rawData - Raw data from `plugin.loadData()`
 * @param saveData - Callback to write data.json (for migration cleanup)
 */
export async function loadSettingsWithKeychain(
  rawData: unknown,
  saveData: (data: CopilotSettings) => Promise<void>
): Promise<CopilotSettings> {
  // Reason: sanitize FIRST to normalize model providers (e.g. azure_openai → azure-openai).
  // This ensures model identity is consistent between migration writes and hydrate reads.
  let settings = sanitizeSettings(rawData as CopilotSettings);

  const keychain = KeychainService.getInstance();
  if (!keychain.isAvailable()) {
    return settings;
  }

  // One-time migration from legacy encryption to keychain
  if (!settings._keychainMigrated) {
    logInfo("Settings load: keychain available, checking for legacy secrets to migrate");
    const result = await keychain.migrateFromLegacy(settings);
    if (result.migrated) {
      try {
        await saveData(result.settings);
      } catch (error) {
        // Reason: Migration wrote secrets to keychain successfully, but failed to
        // persist the cleaned data.json with _keychainMigrated flag. This is non-fatal:
        // - Keychain already has correct secrets, so this startup works fine
        // - Next startup will re-run migration (idempotent — getDecryptedKey on plaintext is a no-op)
        // - We do NOT want to abort plugin load over a saveData failure
        logError("Failed to save migration marker to data.json — will retry next startup", error);
      }
      settings = result.settings;
    }
  }

  // Hydrate secrets from keychain into memory
  settings = await keychain.hydrateSecrets(settings);

  return settings;
}

/**
 * Wait for all queued persistence operations to complete.
 * Best-effort — `onunload()` is `void` so the caller cannot truly await this.
 */
export async function flushPersistence(): Promise<void> {
  await writeQueue;
}

// ── Internal ──────────────────────────────────────────────────────

/** Core persistence logic, called within the write queue. */
async function doPersist(
  settings: CopilotSettings,
  saveData: (data: CopilotSettings) => Promise<void>,
  prevSettings?: CopilotSettings
): Promise<void> {
  const keychain = KeychainService.getInstance();

  if (!keychain.isAvailable()) {
    return doLegacyPersist(settings, saveData);
  }

  const { stripped, secretEntries, keychainIdsToDelete } = keychain.persistSecrets(
    settings,
    prevSettings
  );

  // Step 1: Write secrets to keychain FIRST
  // Reason: If keychain write fails, we throw before touching data.json,
  // so data.json retains its old values and nothing is lost.
  for (const [id, value] of secretEntries) {
    await keychain.setSecretById(id, value);
  }

  // Clean up deleted model entries
  for (const id of keychainIdsToDelete) {
    try {
      await keychain.setSecretById(id, "");
    } catch (error) {
      // Reason: Cleanup failure is non-critical — orphaned entries don't cause issues.
      logError(`Failed to clean up keychain entry ${id}:`, error);
    }
  }

  // Step 2: Write stripped settings to data.json
  // Reason: If saveData fails, keychain already has the latest secrets and memory
  // retains the current state. Next successful persist will reconcile data.json.
  // We do NOT roll back keychain — that would create a split where memory has new
  // values but keychain has old values, which is worse than the forward-only approach.
  const dataToSave: CopilotSettings = { ...stripped, _keychainMigrated: true };
  await saveData(dataToSave);
}

/** Legacy persistence path when keychain is not available. */
async function doLegacyPersist(
  settings: CopilotSettings,
  saveData: (data: CopilotSettings) => Promise<void>
): Promise<void> {
  if (settings.enableEncryption) {
    await saveData(await encryptAllKeys(settings));
  } else {
    await saveData(settings);
  }
}
