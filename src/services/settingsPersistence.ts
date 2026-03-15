import { type CopilotSettings, sanitizeSettings } from "@/settings/model";
import { encryptAllKeys, isEncryptedValue, getDecryptedKey, isSensitiveKey } from "@/encryptionService";
import { KeychainService } from "@/services/keychainService";
import { logError, logInfo, logWarn } from "@/logger";

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
        // Reason: hydrate from keychain first so the portable fallback in data.json
        // reflects the verified keychain values, not the stale source settings.
        // On migration retry, keychain may have newer values than result.settings.
        const hydrated = await keychain.hydrateSecrets(result.settings);
        const encrypted = await encryptAllKeys(hydrated);
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

  // Reason: `_keychainMigrated` may have been synced from another device whose
  // safeStorage encrypted the data.json fallback values. If any secret is still
  // encrypted after hydration (meaning local keychain didn't have it), the flag
  // is invalid on this device. Clear it so saves use the legacy path until this
  // device's own migration succeeds.
  if (settings._keychainMigrated && hasEncryptedSecrets(settings)) {
    logWarn(
      "Settings load: _keychainMigrated flag appears synced from another device. " +
        "Clearing flag to trigger local migration on next startup."
    );
    settings = { ...settings, _keychainMigrated: false } as CopilotSettings;
    // Reason: persist the cleared flag to data.json so the next startup
    // actually re-runs migration instead of re-detecting the stale flag.
    try {
      const encrypted = await encryptAllKeys(settings);
      await saveData(encrypted);
    } catch {
      // Non-fatal: worst case is re-detection on next startup.
      logWarn("Failed to persist cleared _keychainMigrated flag.");
    }
  }

  return settings;
}

/**
 * Check whether any sensitive field (top-level or model-level) still holds
 * an encrypted value after hydration. Used to detect synced `_keychainMigrated`
 * flags from another device where the local keychain didn't have the plaintext.
 */
function hasEncryptedSecrets(settings: CopilotSettings): boolean {
  // Check top-level sensitive fields
  for (const key of Object.keys(settings)) {
    if (!isSensitiveKey(key)) continue;
    const value = (settings as unknown as Record<string, unknown>)[key];
    if (typeof value === "string" && isEncryptedValue(value)) {
      return true;
    }
  }

  // Check model-level secret fields (apiKey, openAIOrgId)
  const modelLists = [settings.activeModels, settings.activeEmbeddingModels];
  for (const models of modelLists) {
    if (!models?.length) continue;
    for (const model of models) {
      const record = model as unknown as Record<string, unknown>;
      for (const field of ["apiKey", "openAIOrgId"]) {
        const value = record[field];
        if (typeof value === "string" && isEncryptedValue(value)) {
          return true;
        }
      }
    }
  }

  return false;
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
  // Keychain is only used when encryption is on, keychain is available, AND migration
  // has completed. Without the migration gate, a synced vault with enc_desk_ secrets
  // from another desktop would hit the decrypt-guard and fail every save.
  if (!settings.enableEncryption || !keychain.isAvailable() || !settings._keychainMigrated) {
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
    // Reason: after a keychain reset, memory may hold encrypted data.json values.
    // Writing ciphertext to keychain would poison it permanently. Decrypt first;
    // if decryption fails, abort persistence to avoid silent data corruption.
    let plaintext = value;
    if (isEncryptedValue(value)) {
      plaintext = await getDecryptedKey(value);
      if (!plaintext) {
        throw new Error(`Cannot persist: failed to decrypt secret for keychain entry "${id}".`);
      }
    }
    await keychain.setSecretById(id, plaintext);
  }

  // Clean up deleted model entries (write tombstone "")
  // Reason: if tombstone write fails, hydration would resurrect the deleted secret
  // on next startup. Treat failures the same as normal keychain writes — abort persist.
  for (const id of keychainIdsToDelete) {
    await keychain.setSecretById(id, "");
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
