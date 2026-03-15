import { type App, type SecretStorage } from "obsidian";
import { type CopilotSettings, getModelKeyFromModel } from "@/settings/model";
import { type CustomModel } from "@/aiParams";
import { isSensitiveKey, getDecryptedKey } from "@/encryptionService";
import { logError, logInfo, logWarn } from "@/logger";

/** Prefix for all keychain entries created by this plugin. */
const KEY_PREFIX = "copilot-";

/**
 * Fields that are sensitive but don't match the `isSensitiveKey()` heuristic.
 * Reason: `isSensitiveKey()` is the canonical source of truth for sensitive fields.
 * Add entries here only for fields that are NOT covered by `isSensitiveKey()`.
 */
const EXTRA_SECRET_KEYS: readonly string[] = [];

/**
 * Model-level fields that should be stored in the keychain.
 * Each gets its own keychain entry with a distinct prefix.
 */
const MODEL_SECRET_FIELDS = ["apiKey", "openAIOrgId"] as const;
type ModelSecretField = (typeof MODEL_SECRET_FIELDS)[number];

/**
 * Scope distinguishing chat models from embedding models in keychain IDs.
 * Reason: `activeModels` and `activeEmbeddingModels` can contain models with
 * the same `name|provider` identity but different API keys. Without scope,
 * they'd collide in the keychain namespace.
 */
type ModelScope = "chat" | "embedding";

/** Keychain ID prefixes for model-level secrets. */
const MODEL_FIELD_PREFIX: Record<ModelSecretField, string> = {
  apiKey: `${KEY_PREFIX}model-key-`,
  openAIOrgId: `${KEY_PREFIX}model-org-`,
};

/**
 * Check whether a settings key should be stored in the OS keychain.
 * Combines the heuristic `isSensitiveKey()` with an explicit exception list.
 */
export function isSecretKey(key: string): boolean {
  return isSensitiveKey(key) || EXTRA_SECRET_KEYS.includes(key);
}

/**
 * Convert a camelCase settings key to a kebab-case keychain ID.
 * Example: `openAIApiKey` → `copilot-open-ai-api-key`
 */
function toKeychainId(settingsKey: string): string {
  const kebab = settingsKey
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
  return `${KEY_PREFIX}${kebab}`;
}

/**
 * Build a keychain ID for a model-level secret.
 * Reason: Uses `encodeURIComponent` instead of lossy sanitize to avoid ID collisions.
 * Different model names with special characters won't converge to the same ID.
 * Includes scope (`chat`/`embedding`) to prevent cross-list collisions.
 * @param scope - Whether this is a chat model or embedding model
 * @param modelIdentity - Stable identity from `getModelKeyFromModel()` (e.g. `gpt-4|openai`)
 * @param field - Which model field (`apiKey` or `openAIOrgId`)
 */
function toModelKeychainId(scope: ModelScope, modelIdentity: string, field: ModelSecretField): string {
  return `${MODEL_FIELD_PREFIX[field]}${scope}-${encodeURIComponent(modelIdentity)}`;
}

/** Result of a legacy migration attempt. */
export interface MigrationResult {
  settings: CopilotSettings;
  migrated: boolean;
}

/** Output of `persistSecrets()` — what to write to keychain and what to clean up. */
export interface PersistSecretsResult {
  /** Entries to write to keychain: `[keychainId, value]` pairs. */
  secretEntries: Array<[string, string]>;
  /** Keychain IDs of deleted models to clear. */
  keychainIdsToDelete: string[];
}

/**
 * Singleton service for reading/writing secrets via Obsidian's SecretStorage (OS Keychain).
 *
 * Responsibilities:
 * - Store and retrieve API keys and tokens in the OS keychain
 * - Migrate secrets from legacy data.json encryption to keychain (one-time)
 * - Hydrate in-memory settings with plaintext secrets on startup
 * - Extract secrets from settings for persistence (strip before saving data.json)
 */
export class KeychainService {
  private static instance: KeychainService | null = null;
  private app: App;

  private constructor(app: App) {
    this.app = app;
  }

  /** Get or create the singleton instance. Must be called with `app` on plugin load. */
  static getInstance(app?: App): KeychainService {
    if (!KeychainService.instance) {
      if (!app) {
        throw new Error("KeychainService must be initialized with app on first call");
      }
      KeychainService.instance = new KeychainService(app);
    }
    return KeychainService.instance;
  }

  /** Reset the singleton (for testing). */
  static resetInstance(): void {
    KeychainService.instance = null;
  }

  /** Whether the OS keychain is available in this Obsidian version. */
  isAvailable(): boolean {
    return !!this.app.secretStorage;
  }

  /**
   * Access SecretStorage with a runtime guard.
   * Reason: replaces scattered non-null assertions (`this.storage`)
   * with a single guard that produces a clear error when keychain is unavailable.
   */
  private get storage(): SecretStorage {
    if (!this.app.secretStorage) {
      throw new Error("OS keychain (SecretStorage) is not available.");
    }
    return this.app.secretStorage;
  }

  /**
   * Write a value directly to the keychain using a pre-computed ID.
   * Reason: `persistSecrets()` and `migrateFromLegacy()` already compute final keychain IDs.
   * Using `setSecret()` would double-convert the ID. This method bypasses ID conversion.
   */
  async setSecretById(keychainId: string, value: string): Promise<void> {
    await this.storage.setSecret(keychainId, value);
  }

  /** Store a top-level secret in the keychain. */
  async setSecret(settingsKey: string, value: string): Promise<void> {
    const id = toKeychainId(settingsKey);
    await this.storage.setSecret(id, value);
  }

  /** Retrieve a top-level secret from the keychain. Returns `null` if not found. */
  async getSecret(settingsKey: string): Promise<string | null> {
    const id = toKeychainId(settingsKey);
    return this.storage.getSecret(id);
  }

  /** Store a model-level secret in the keychain. */
  async setModelSecret(
    scope: ModelScope,
    modelIdentity: string,
    field: ModelSecretField,
    value: string
  ): Promise<void> {
    const id = toModelKeychainId(scope, modelIdentity, field);
    await this.storage.setSecret(id, value);
  }

  /** Retrieve a model-level secret from the keychain. Returns `null` if not found. */
  async getModelSecret(
    scope: ModelScope,
    modelIdentity: string,
    field: ModelSecretField
  ): Promise<string | null> {
    const id = toModelKeychainId(scope, modelIdentity, field);
    return this.storage.getSecret(id);
  }

  /**
   * Overlay keychain secrets onto in-memory settings.
   * Called at startup after sanitizeSettings(). Empty/null keychain values
   * are treated as absent and do not overwrite existing memory values.
   */
  async hydrateSecrets(settings: CopilotSettings): Promise<CopilotSettings> {
    const hydrated = { ...settings };

    // Hydrate top-level secrets
    for (const key of Object.keys(hydrated)) {
      if (!isSecretKey(key)) continue;
      const value = await this.getSecret(key);
      // Reason: `null` means "not in keychain" → keep the disk value (backward compat).
      // `""` means "explicitly deleted" (tombstone) → override disk value to prevent
      // a stale data.json secret from resurrecting after a failed saveData().
      if (value === null) continue;
      (hydrated as unknown as Record<string, unknown>)[key] = value;
    }

    // Hydrate model-level secrets
    hydrated.activeModels = await this.hydrateModelSecrets("chat", hydrated.activeModels);
    hydrated.activeEmbeddingModels = await this.hydrateModelSecrets(
      "embedding",
      hydrated.activeEmbeddingModels
    );

    return hydrated;
  }

  /**
   * Extract secrets from settings for keychain persistence.
   * Returns entries to write to keychain and IDs to clean up.
   * Does NOT modify the settings object — data.json is written separately
   * by the caller using `encryptAllKeys()` for portable fallback.
   */
  persistSecrets(
    settings: CopilotSettings,
    prevSettings?: CopilotSettings
  ): PersistSecretsResult {
    const secretEntries: Array<[string, string]> = [];
    const clearedSecretIds: string[] = [];

    // Collect top-level secrets
    for (const key of Object.keys(settings)) {
      if (!isSecretKey(key)) continue;
      const value = (settings as unknown as Record<string, unknown>)[key];
      const id = toKeychainId(key);

      if (typeof value === "string" && value.length > 0) {
        secretEntries.push([id, value]);
      } else if (prevSettings) {
        // Reason: If the user cleared this secret (was non-empty, now empty),
        // we must also clear it from keychain. Otherwise hydrateSecrets() will
        // restore the old value on next startup, making deletion ineffective.
        const prevValue = (prevSettings as unknown as Record<string, unknown>)[key];
        if (typeof prevValue === "string" && prevValue.length > 0) {
          clearedSecretIds.push(id);
        }
      }
    }

    // Collect model-level secrets
    this.collectModelSecrets("chat", settings.activeModels, secretEntries,
      prevSettings?.activeModels, clearedSecretIds);
    this.collectModelSecrets("embedding", settings.activeEmbeddingModels, secretEntries,
      prevSettings?.activeEmbeddingModels, clearedSecretIds);

    // Find deleted models to clean up their keychain entries (per scope)
    const keychainIdsToDelete = [
      ...this.getDeletedModelKeysForScope(
        "chat",
        prevSettings?.activeModels,
        settings.activeModels
      ),
      ...this.getDeletedModelKeysForScope(
        "embedding",
        prevSettings?.activeEmbeddingModels,
        settings.activeEmbeddingModels
      ),
      ...clearedSecretIds,
    ];

    return { secretEntries, keychainIdsToDelete };
  }

  /**
   * One-time migration from legacy encryption (data.json) to OS keychain.
   *
   * Steps:
   * 1. Decrypt all top-level secrets and model secrets via `getDecryptedKey()`
   * 2. Write plaintext values to keychain (skip if keychain already has a non-empty value)
   * 3. Read back all values to verify
   * 4. If all verified → return cleaned settings with `_keychainMigrated: true`
   * 5. If any verification fails → return original settings unchanged
   */
  async migrateFromLegacy(settings: CopilotSettings): Promise<MigrationResult> {
    logInfo("Keychain migration: starting legacy → keychain migration");

    const written: Array<[string, string]> = [];

    try {
      // Migrate top-level secrets
      for (const key of Object.keys(settings)) {
        if (!isSecretKey(key)) continue;
        const raw = (settings as unknown as Record<string, unknown>)[key];
        if (typeof raw !== "string" || raw.length === 0) continue;

        const plaintext = await getDecryptedKey(raw);
        if (!plaintext || plaintext.length === 0) {
          // Reason: raw is non-empty but decryption returned empty — this means
          // the value exists but can't be decrypted on this device (e.g. different
          // machine's Electron safeStorage key). Abort entire migration to avoid
          // data loss: the encrypted value would remain only in data.json with no
          // keychain backup, leading to inconsistent state.
          logWarn(
            `Keychain migration: failed to decrypt "${key}" — aborting migration. ` +
              "Will retry on next startup."
          );
          return { settings, migrated: false };
        }

        const id = toKeychainId(key);

        // Reason: If this is a migration retry (previous saveData failed but keychain
        // was partially written), the keychain may already have a newer value that the
        // user set after the first migration attempt. Only back-fill missing entries;
        // never overwrite an existing non-empty keychain value with a stale data.json value.
        const existing = await this.storage.getSecret(id);
        if (!existing || existing.length === 0) {
          await this.storage.setSecret(id, plaintext);
          written.push([id, plaintext]);
        } else {
          written.push([id, existing]);
        }
      }

      // Migrate model-level secrets (per scope to avoid cross-list collisions)
      const modelGroups: Array<[ModelScope, CustomModel[]]> = [
        ["chat", settings.activeModels ?? []],
        ["embedding", settings.activeEmbeddingModels ?? []],
      ];
      for (const [scope, models] of modelGroups) {
        for (const model of models) {
          const identity = getModelKeyFromModel(model);
          for (const field of MODEL_SECRET_FIELDS) {
            const raw = model[field];
            if (typeof raw !== "string" || raw.length === 0) continue;

            const plaintext = await getDecryptedKey(raw);
            if (!plaintext || plaintext.length === 0) {
              // Reason: Same as above — non-empty raw but decryption failed.
              logWarn(
                `Keychain migration: failed to decrypt model secret ` +
                  `"${field}" for "${identity}" — aborting migration.`
              );
              return { settings, migrated: false };
            }

            const id = toModelKeychainId(scope, identity, field);

            // Reason: Same back-fill-only logic as top-level secrets.
            const existing = await this.storage.getSecret(id);
            if (!existing || existing.length === 0) {
              await this.storage.setSecret(id, plaintext);
              written.push([id, plaintext]);
            } else {
              written.push([id, existing]);
            }
          }
        }
      }

      // Verify all written values by reading back
      for (const [id, expected] of written) {
        const actual = await this.storage.getSecret(id);
        if (actual !== expected) {
          logWarn(
            `Keychain migration: verification failed for ${id}. ` +
              "Migration aborted — will retry on next startup."
          );
          return { settings, migrated: false };
        }
      }

      // All verified — mark as migrated but keep existing values in settings.
      // Reason: data.json retains encrypted/plaintext secrets as a portable fallback
      // for non-keychain platforms (mobile, older Obsidian). The caller will re-encrypt
      // before writing to data.json. Desktop with keychain overrides these via hydration.
      const migrated = { ...settings, _keychainMigrated: true } as CopilotSettings;

      logInfo(
        `Keychain migration: successfully migrated ${written.length} secrets to OS keychain`
      );
      return { settings: migrated, migrated: true };
    } catch (error) {
      logError("Keychain migration failed — will retry on next startup:", error);
      return { settings, migrated: false };
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /** Overlay keychain values onto a list of models. */
  private async hydrateModelSecrets(scope: ModelScope, models: CustomModel[]): Promise<CustomModel[]> {
    if (!models?.length) return models;

    const hydrated: CustomModel[] = [];
    for (const model of models) {
      const identity = getModelKeyFromModel(model);
      const copy = { ...model };

      for (const field of MODEL_SECRET_FIELDS) {
        const value = await this.getModelSecret(scope, identity, field);
        // Reason: same tombstone logic as top-level hydration —
        // `null` = not in keychain (keep disk), `""` = explicitly deleted.
        if (value === null) continue;
        (copy as unknown as Record<string, unknown>)[field] = value;
      }

      hydrated.push(copy);
    }
    return hydrated;
  }

  /** Collect model-level secret entries and cleared IDs without modifying models. */
  private collectModelSecrets(
    scope: ModelScope,
    models: CustomModel[],
    secretEntries: Array<[string, string]>,
    prevModels?: CustomModel[],
    clearedSecretIds?: string[]
  ): void {
    if (!models?.length) return;

    // Build a lookup of previous model secrets for detecting cleared fields
    const prevModelMap = new Map<string, CustomModel>();
    if (prevModels) {
      for (const m of prevModels) {
        prevModelMap.set(getModelKeyFromModel(m), m);
      }
    }

    for (const model of models) {
      const identity = getModelKeyFromModel(model);
      const prevModel = prevModelMap.get(identity);

      for (const field of MODEL_SECRET_FIELDS) {
        const value = model[field];
        const id = toModelKeychainId(scope, identity, field);

        if (typeof value === "string" && value.length > 0) {
          secretEntries.push([id, value]);
        } else if (prevModel && clearedSecretIds) {
          // Reason: If this model field was non-empty before but is now empty,
          // we must clear it from keychain to prevent hydrateSecrets() from
          // restoring the old value on next startup.
          const prevValue = prevModel[field];
          if (typeof prevValue === "string" && prevValue.length > 0) {
            clearedSecretIds.push(id);
          }
        }
      }
    }
  }

  /** Find keychain IDs for models deleted from a specific scope (chat or embedding). */
  private getDeletedModelKeysForScope(
    scope: ModelScope,
    prevModels: CustomModel[] | undefined,
    currentModels: CustomModel[]
  ): string[] {
    if (!prevModels?.length) return [];

    const currentIds = new Set((currentModels ?? []).map(getModelKeyFromModel));

    return prevModels
      .filter((m) => !currentIds.has(getModelKeyFromModel(m)))
      .flatMap((m) => {
        const identity = getModelKeyFromModel(m);
        return MODEL_SECRET_FIELDS.map((field) => toModelKeychainId(scope, identity, field));
      });
  }

}
