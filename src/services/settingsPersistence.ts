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
 * 1. Extract secrets from settings → get secret entries for keychain
 * 2. Write secrets to keychain FIRST (never clear data.json before keychain confirmed)
 * 3. Write encrypted settings to data.json as portable fallback (with `_keychainMigrated: true`)
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

  // Reason: when encryption is off, skip both migration and hydration entirely.
  // If the user turned off encryption after a prior migration, secrets already
  // exist in data.json as plaintext (written by doLegacyPersist). Hydrating stale
  // keychain values would overwrite those plaintext values — effectively ignoring
  // the user's choice to disable encryption.
  if (!settings.enableEncryption) {
    return settings;
  }

  // One-time migration from legacy encryption to keychain
  if (!settings._keychainMigrated) {
    logInfo("Settings load: keychain available, checking for legacy secrets to migrate");
    const result = await keychain.migrateFromLegacy(settings);
    if (result.migrated) {
      try {
        // Reason: encrypt before writing to data.json to maintain the portable
        // fallback invariant. Source settings may be plaintext (legacy failure case),
        // so we must not persist them unencrypted even during migration writeback.
        const encrypted = await encryptAllKeys(result.settings);
        await saveData({ ...encrypted, _keychainMigrated: true });
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

  // Reason: respect the user's `enableEncryption` toggle. When off, secrets stay
  // in data.json as plaintext — useful for users who need to sync/edit settings manually.
  // Keychain is only used when the user explicitly opts into encryption.
  if (!settings.enableEncryption || !keychain.isAvailable()) {
    return doLegacyPersist(settings, saveData);
  }

  const { secretEntries, keychainIdsToDelete } = keychain.persistSecrets(
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

  // Step 2: Write encrypted settings to data.json as a portable fallback.
  // Reason: data.json syncs across devices. Non-keychain platforms (mobile, older
  // Obsidian) cannot access SecretStorage, so they need encrypted copies to decrypt
  // locally. Desktop with keychain ignores these — hydrateSecrets() overwrites them
  // with plaintext from keychain at startup.
  const encrypted = await encryptAllKeys(settings);
  const dataToSave: CopilotSettings = { ...encrypted, _keychainMigrated: true };
  await saveData(dataToSave);
}

/** Legacy persistence path when keychain is not available or encryption is off. */
async function doLegacyPersist(
  settings: CopilotSettings,
  saveData: (data: CopilotSettings) => Promise<void>
): Promise<void> {
  if (settings.enableEncryption) {
    await saveData(await encryptAllKeys(settings));
  } else {
    // Reason: clear _keychainMigrated so next startup doesn't attempt to hydrate
    // stale keychain entries over the plaintext values the user chose to keep.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _keychainMigrated, ...rest } = settings as CopilotSettings & {
      _keychainMigrated?: boolean;
    };
    await saveData(rest as CopilotSettings);
  }
}
