/**
 * Type augmentation for Obsidian SecretStorage API (available since 1.11.4).
 *
 * Reason: the npm package `obsidian@1.2.5` does not include SecretStorage
 * types. This augmentation adds them so TypeScript can type-check our
 * keychain integration without runtime changes.
 */
import "obsidian";

declare module "obsidian" {
  interface App {
    /** OS-level secret storage backed by the system keychain. Available since Obsidian 1.11.4. */
    secretStorage?: SecretStorage;
  }

  interface SecretStorage {
    /** Store a secret under the given identifier. */
    setSecret(id: string, secret: string): Promise<void>;

    /** Retrieve a secret by identifier. Returns `null` if not found. */
    getSecret(id: string): Promise<string | null>;

    /** List all stored secret identifiers. */
    listSecrets(): Promise<string[]>;

    // Reason: `deleteSecret` is NOT declared here because the official
    // Obsidian documentation only lists the three methods above.
    // Use `setSecret(id, "")` to clear a secret instead.
  }
}
