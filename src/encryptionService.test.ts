import { TextDecoder, TextEncoder } from "util";

// Mock electron module with proper types
const mockElectron = {
  remote: {
    safeStorage: {
      encryptString: jest.fn().mockImplementation((text) => Buffer.from(`${text}_encrypted`)),
      decryptString: jest
        .fn()
        .mockImplementation((buffer) => buffer.toString().replace("_encrypted", "")),
      isEncryptionAvailable: jest.fn().mockReturnValue(true),
    },
  },
};

jest.mock("electron", () => mockElectron);

global.TextEncoder = TextEncoder as any;
global.TextDecoder = TextDecoder as any;

// Now we can import our modules
import {
  base64ToArrayBuffer,
  encryptAllKeys,
  getDecryptedKey,
  getEncryptedKey,
  isEncryptedValue,
  isSensitiveKey,
} from "@/encryptionService";
import { type CopilotSettings } from "@/settings/model";
import { Buffer } from "buffer";

// Mock btoa/atob for base64 encoding/decoding (binary-safe).
// Reason: production code builds "binary strings" via String.fromCharCode(bytes[i]),
// which can include chars >= 0x80. Use latin1 to preserve the full 0–255 byte range.
global.btoa = jest.fn().mockImplementation((str) => Buffer.from(str, "latin1").toString("base64"));
global.atob = jest.fn().mockImplementation((str) => Buffer.from(str, "base64").toString("latin1"));

/**
 * Ensure `globalThis.localStorage` is usable for tests.
 *
 * Reason: jest uses `testEnvironment: "jsdom"`, so a native Storage
 * implementation usually exists. We only install an in-memory shim when
 * the native implementation is unusable (e.g., opaque origin throws).
 */
function ensureTestLocalStorage(): { clear: () => void } {
  try {
    const storage = globalThis.localStorage;
    storage.setItem("__copilot_test__", "1");
    storage.removeItem("__copilot_test__");
    // Native jsdom localStorage works — use it directly
    return { clear: () => globalThis.localStorage.clear() };
  } catch {
    // Native localStorage unavailable — install an in-memory shim
    const data = new Map<string, string>();
    const shim = {
      getItem: jest.fn((key: string) => data.get(key) ?? null),
      setItem: jest.fn((key: string, value: string) => { data.set(key, value); }),
      removeItem: jest.fn((key: string) => { data.delete(key); }),
      clear: jest.fn(() => data.clear()),
    };
    try {
      Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).localStorage = shim;
    }
    return { clear: () => data.clear() };
  }
}

const testLocalStorage = ensureTestLocalStorage();

// Reason: mock getRandomValues to produce incrementing bytes so each call
// returns different data (simulating unique IVs).
let randomCounter = 1;
Object.defineProperty(global.crypto, "getRandomValues", {
  value: jest.fn((arr: Uint8Array) => {
    for (let i = 0; i < arr.length; i++) arr[i] = (randomCounter++ & 0xff) as number;
    return arr;
  }),
  configurable: true,
});

const mockSubtle = {
  importKey: jest.fn().mockResolvedValue("mockCryptoKey"),
  encrypt: jest.fn().mockImplementation((algorithm, key, data) => {
    const originalText = new TextDecoder().decode(data);
    // Reason: embed IV info in mock output so we can verify uniqueness
    const iv = (algorithm as { iv?: Uint8Array })?.iv;
    const ivTag = iv ? Array.from(iv.slice(0, 4)).join(",") : "noiv";
    const encryptedText = `${originalText}_encrypted_${ivTag}`;
    return Promise.resolve(new TextEncoder().encode(encryptedText).buffer);
  }),
  decrypt: jest.fn().mockImplementation((algorithm, key, data) => {
    const encryptedText = new TextDecoder().decode(new Uint8Array(data));
    const originalText = encryptedText.replace(/_encrypted_.+$/, "");
    return Promise.resolve(new TextEncoder().encode(originalText).buffer);
  }),
};

// Mock crypto.subtle instead of the entire crypto object
Object.defineProperty(global.crypto, "subtle", {
  value: mockSubtle,
  configurable: true,
});

describe("EncryptionService", () => {
  beforeEach(() => {
    // Reason: imports are resolved at module scope, so jest.resetModules()
    // wouldn't affect them. Reset mutable state explicitly instead.
    jest.clearAllMocks();
    randomCounter = 1;
    testLocalStorage.clear();
    // Restore default mock behavior between tests
    mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(true);
  });

  describe("getEncryptedKey", () => {
    it("should encrypt an API key", async () => {
      const apiKey = "testApiKey";
      const encryptedKey = await getEncryptedKey(apiKey);
      // The key is base64 encoded, so we should expect that format
      expect(encryptedKey).toMatch(/^enc_(desk|web)_[A-Za-z0-9+/=]+$/);
      // Verify we can decrypt it back
      const decryptedKey = await getDecryptedKey(encryptedKey);
      expect(decryptedKey).toBe(apiKey);
    });

    it("should return the original key if already encrypted", async () => {
      const apiKey = "enc_testApiKey";
      const encryptedKey = await getEncryptedKey(apiKey);
      expect(encryptedKey).toBe(apiKey);
    });

    it("should produce different ciphertext for same plaintext (unique IV)", async () => {
      // Reason: use WebCrypto path by disabling safeStorage
      mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);
      const apiKey = "sameKey";

      const encrypted1 = await getEncryptedKey(apiKey);
      const encrypted2 = await getEncryptedKey(apiKey);

      expect(encrypted1).toMatch(/^enc_web_[A-Za-z0-9+/=]+$/);
      expect(encrypted2).toMatch(/^enc_web_[A-Za-z0-9+/=]+$/);
      // Each encryption must use a different random IV
      expect(encrypted1).not.toBe(encrypted2);
    });

    it("should encode WebCrypto payload with CP00 portable magic + IV", async () => {
      mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);
      const encrypted = await getEncryptedKey("testMagic");

      expect(encrypted).toMatch(/^enc_web_[A-Za-z0-9+/=]+$/);
      const base64Data = encrypted.replace(/^enc_web_/, "");
      const bytes = new Uint8Array(base64ToArrayBuffer(base64Data));

      // First 4 bytes should be "CP00" portable magic header
      expect(Array.from(bytes.slice(0, 4))).toEqual([0x43, 0x50, 0x30, 0x30]);
    });

    it("should still encrypt when localStorage is not writable (portable key)", async () => {
      mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);

      // Reason: jsdom's native Storage methods are not jest-spyable.
      // Temporarily replace localStorage with a broken shim to simulate
      // an environment where localStorage is disabled.
      const originalStorage = globalThis.localStorage;
      const brokenStorage = {
        getItem: () => null,
        setItem: () => { throw new Error("localStorage disabled"); },
        removeItem: () => {},
        clear: () => {},
        get length() { return 0; },
        key: () => null,
      } as Storage;
      Object.defineProperty(globalThis, "localStorage", {
        value: brokenStorage,
        configurable: true,
      });

      try {
        // Reason: portable key doesn't need localStorage, so encryption should succeed
        const encrypted = await getEncryptedKey("portableKey");
        expect(encrypted).toMatch(/^enc_web_[A-Za-z0-9+/=]+$/);
        const decrypted = await getDecryptedKey(encrypted);
        expect(decrypted).toBe("portableKey");
      } finally {
        // Reason: always restore localStorage to avoid leaking state into later tests
        Object.defineProperty(globalThis, "localStorage", {
          value: originalStorage,
          configurable: true,
        });
      }
    });

    it("should throw rather than returning plaintext when encryption fails", async () => {
      mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);
      mockSubtle.encrypt.mockImplementationOnce(() => {
        throw new Error("encrypt boom");
      });

      await expect(getEncryptedKey("secretApiKey")).rejects.toThrow(
        /Refusing to write plaintext/i
      );
    });
  });

  describe("getDecryptedKey", () => {
    it("should decrypt an encrypted API key", async () => {
      const apiKey = "testApiKey";
      const encryptedKey = await getEncryptedKey(apiKey);
      const decryptedKey = await getDecryptedKey(encryptedKey);
      expect(decryptedKey).toBe(apiKey);
    });

    it("should return the original key if it is in plain text", async () => {
      const apiKey = "testApiKey";
      const decryptedKey = await getDecryptedKey(apiKey);
      expect(decryptedKey).toBe(apiKey);
    });

    it("should decrypt CP00 portable payloads", async () => {
      mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);

      // Reason: manually construct a CP00 payload to verify the portable
      // format decryption works correctly.
      const plaintext = "legacyPortableSecret";
      const iv = new Uint8Array(12);
      iv[0] = 1;

      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          "mockCryptoKey" as any,
          new TextEncoder().encode(plaintext)
        )
      );

      const cp00 = new Uint8Array([0x43, 0x50, 0x30, 0x30]); // "CP00"
      const payload = new Uint8Array(cp00.length + iv.length + ciphertext.length);
      payload.set(cp00, 0);
      payload.set(iv, cp00.length);
      payload.set(ciphertext, cp00.length + iv.length);

      const base64 = Buffer.from(payload).toString("base64");
      const decrypted = await getDecryptedKey(`enc_web_${base64}`);
      expect(decrypted).toBe(plaintext);
    });

    it("should decrypt legacy fixed-IV enc_web_ payloads", async () => {
      mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);

      // Reason: simulate the original WebCrypto format (no magic header,
      // fixed all-zero IV, hardcoded key) to verify backward compat.
      const plaintext = "legacyFixedIvSecret";
      const legacyIv = new Uint8Array(12); // all zeros, matches legacy scheme
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: legacyIv },
          "mockCryptoKey" as any,
          new TextEncoder().encode(plaintext)
        )
      );

      const base64 = Buffer.from(ciphertext).toString("base64");
      const decrypted = await getDecryptedKey(`enc_web_${base64}`);
      expect(decrypted).toBe(plaintext);
    });

    it("should decrypt legacy enc_ prefix payloads via WebCrypto fallback", async () => {
      mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);

      const plaintext = "legacyEncPrefixSecret";
      const legacyIv = new Uint8Array(12);
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: legacyIv },
          "mockCryptoKey" as any,
          new TextEncoder().encode(plaintext)
        )
      );

      const base64 = Buffer.from(ciphertext).toString("base64");
      const decrypted = await getDecryptedKey(`enc_${base64}`);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("encryptAllKeys", () => {
    it("should encrypt all keys containing 'apikey'", async () => {
      const settings = {
        enableEncryption: true,
        openAIApiKey: "testApiKey",
        cohereApiKey: "anotherTestApiKey",
        userSystemPrompt: "shouldBeIgnored",
      } as unknown as CopilotSettings;

      const newSettings = await encryptAllKeys(settings);
      expect(newSettings.openAIApiKey).toMatch(/^enc_(desk|web)_[A-Za-z0-9+/=]+$/);
      expect(newSettings.cohereApiKey).toMatch(/^enc_(desk|web)_[A-Za-z0-9+/=]+$/);
      expect(newSettings.userSystemPrompt).toBe("shouldBeIgnored");

      // Verify we can decrypt the keys back
      const decryptedOpenAI = await getDecryptedKey(newSettings.openAIApiKey);
      const decryptedCohere = await getDecryptedKey(newSettings.cohereApiKey);
      expect(decryptedOpenAI).toBe("testApiKey");
      expect(decryptedCohere).toBe("anotherTestApiKey");
    });

    it("should not encrypt keys when encryption is not enabled", async () => {
      const newSettings = await encryptAllKeys({
        enableEncryption: false,
        openAIApiKey: "testApiKey",
        cohereApiKey: "anotherTestApiKey",
        userSystemPrompt: "shouldBeIgnored",
      } as unknown as CopilotSettings);
      expect(newSettings.openAIApiKey).toBe("testApiKey");
      expect(newSettings.cohereApiKey).toBe("anotherTestApiKey");
      expect(newSettings.userSystemPrompt).toBe("shouldBeIgnored");
    });

    it("should recursively encrypt nested sensitive keys", async () => {
      const settings = {
        enableEncryption: true,
        openAIApiKey: "topLevelKey",
        providerConfigs: {
          openai: { apiKey: "nestedProviderKey", model: "gpt-4" },
        },
        activeModels: [
          { name: "gpt-4", apiKey: "modelKey", enabled: true },
        ],
      } as unknown as CopilotSettings;

      const newSettings = await encryptAllKeys(settings);

      // Top-level sensitive key should be encrypted
      expect(newSettings.openAIApiKey).toMatch(/^enc_(desk|web)_/);

      // Nested sensitive key inside providerConfigs should also be encrypted
      const nestedConfig = (newSettings as any).providerConfigs?.openai;
      expect(nestedConfig.apiKey).toMatch(/^enc_(desk|web)_/);
      expect(nestedConfig.model).toBe("gpt-4");

      // Model array sensitive keys should be encrypted
      expect((newSettings as any).activeModels[0].apiKey).toMatch(/^enc_(desk|web)_/);
      expect((newSettings as any).activeModels[0].name).toBe("gpt-4");
    });
  });

  describe("getDecryptedKey — failure returns empty string", () => {
    it("should return empty string when safeStorage is unavailable for desktop key", async () => {
      mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);
      const result = await getDecryptedKey("enc_desk_" + Buffer.from("test").toString("base64"));
      expect(result).toBe("");
    });

    it("should return empty string when WebCrypto decryption throws", async () => {
      mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);
      // Reason: use mockImplementation instead of mockRejectedValueOnce to avoid
      // leaving unconsumed one-shot rejections that could leak into later tests.
      const originalDecrypt = mockSubtle.decrypt.getMockImplementation();
      mockSubtle.decrypt.mockImplementation(() => {
        throw new Error("decrypt boom");
      });

      const result = await getDecryptedKey("enc_web_" + Buffer.from("garbage").toString("base64"));
      expect(result).toBe("");

      // Restore original mock implementation
      mockSubtle.decrypt.mockImplementation(originalDecrypt!);
    });
  });

  describe("isEncryptedValue", () => {
    it.each([
      "enc_desk_abc123",
      "enc_web_abc123",
      "enc_abc123",
    ])('should return true for encrypted value "%s"', (val) => {
      expect(isEncryptedValue(val)).toBe(true);
    });

    it.each([
      "sk-abc123",
      "plaintext-key",
      "",
    ])('should return false for non-encrypted value "%s"', (val) => {
      expect(isEncryptedValue(val)).toBe(false);
    });
  });
});

describe("Cross-platform compatibility", () => {
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    jest.clearAllMocks();
    // Save original console.error
    originalConsoleError = console.error;
    // Mock console.error to suppress expected encryption fallback messages
    console.error = jest.fn();
  });

  afterEach(() => {
    // Restore original console.error
    console.error = originalConsoleError;
  });

  it("should encrypt and decrypt consistently on mobile", async () => {
    // Mock as mobile by making safeStorage unavailable
    mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);

    const originalKey = "testApiKey";
    const encryptedKey = await getEncryptedKey(originalKey);
    expect(encryptedKey).toMatch(/^enc_(desk|web)_[A-Za-z0-9+/=]+$/);

    // Reset the mock counts before decryption
    mockSubtle.encrypt.mockClear();
    mockSubtle.decrypt.mockClear();

    const decryptedKey = await getDecryptedKey(encryptedKey);
    expect(decryptedKey).toBe(originalKey);

    // On mobile, we should use Web Crypto API for decryption
    expect(mockSubtle.decrypt).toHaveBeenCalled();
  });

  it("should be able to decrypt mobile-encrypted keys on desktop", async () => {
    // First encrypt on mobile
    mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(false);

    const originalKey = "testApiKey";
    const mobileEncryptedKey = await getEncryptedKey(originalKey);
    expect(mobileEncryptedKey).toMatch(/^enc_(desk|web)_[A-Za-z0-9+/=]+$/);
    expect(mockSubtle.encrypt).toHaveBeenCalled();

    // Reset the mock counts before desktop decryption
    mockSubtle.encrypt.mockClear();
    mockSubtle.decrypt.mockClear();

    // Then decrypt on desktop
    mockElectron.remote.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    const decryptedKey = await getDecryptedKey(mobileEncryptedKey);
    expect(decryptedKey).toBe(originalKey);
  });
});

// ---------------------------------------------------------------------------
// isSensitiveKey (pure function — no mocks needed)
// ---------------------------------------------------------------------------

describe("isSensitiveKey", () => {
  it.each([
    "openAIApiKey",
    "cohereApiKey",
    "anthropicApiKey",
    "plusLicenseKey",
    "githubCopilotAccessToken",
    "githubCopilotToken",
    "clientSecret",
    "refreshToken",
    "apiPassword",
    "openAIOrgId",
  ])('should return true for sensitive key "%s"', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "temperature",
    "enableEncryption",
    "userSystemPrompt",
    "defaultModelKey",
    "activeModels",
    "maxTokens",
    "githubCopilotTokenExpiresAt",
  ])('should return false for non-sensitive key "%s"', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});
