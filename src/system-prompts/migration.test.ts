import { migrateSystemPromptsFromSettings } from "@/system-prompts/migration";
import { TFile, Vault } from "obsidian";
import * as settingsModel from "@/settings/model";
import * as systemPromptUtils from "@/system-prompts/systemPromptUtils";
import * as logger from "@/logger";

// Mock Obsidian
jest.mock("obsidian", () => ({
  TFile: jest.fn(),
  Vault: jest.fn(),
}));

// Mock settings
jest.mock("@/settings/model", () => ({
  getSettings: jest.fn(),
  updateSetting: jest.fn(),
}));

// Mock logger
jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logError: jest.fn(),
  logWarn: jest.fn(),
}));

// Mock system prompt utils
jest.mock("@/system-prompts/systemPromptUtils", () => ({
  getSystemPromptsFolder: jest.fn(() => "SystemPrompts"),
  getPromptFilePath: jest.fn((title: string) => `SystemPrompts/${title}.md`),
  ensurePromptFrontmatter: jest.fn(),
  loadAllSystemPrompts: jest.fn(),
}));

// Mock ConfirmModal
jest.mock("@/components/modals/ConfirmModal", () => ({
  ConfirmModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
  })),
}));

describe("migrateSystemPromptsFromSettings", () => {
  let mockVault: Vault;
  let originalApp: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock vault
    mockVault = {
      getAbstractFileByPath: jest.fn(),
      createFolder: jest.fn(),
      create: jest.fn(),
    } as unknown as Vault;

    // Mock global app
    originalApp = global.app;
    global.app = {
      vault: mockVault,
    } as any;
  });

  afterEach(() => {
    global.app = originalApp;
  });

  it("skips migration when userSystemPrompt is empty", async () => {
    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: "",
    });

    await migrateSystemPromptsFromSettings(mockVault);

    expect(logger.logInfo).toHaveBeenCalledWith("No legacy userSystemPrompt to migrate");
    expect(mockVault.create).not.toHaveBeenCalled();
  });

  it("skips migration when userSystemPrompt is whitespace only", async () => {
    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: "   ",
    });

    await migrateSystemPromptsFromSettings(mockVault);

    expect(logger.logInfo).toHaveBeenCalledWith("No legacy userSystemPrompt to migrate");
    expect(mockVault.create).not.toHaveBeenCalled();
  });

  it("creates system prompts folder if it does not exist", async () => {
    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: "This is a legacy system prompt.",
    });
    (mockVault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

    await migrateSystemPromptsFromSettings(mockVault);

    expect(mockVault.createFolder).toHaveBeenCalledWith("SystemPrompts");
  });

  it("does not create folder if it already exists", async () => {
    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: "This is a legacy system prompt.",
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce({ path: "SystemPrompts" }) // Folder exists
      .mockReturnValueOnce(null); // File does not exist

    await migrateSystemPromptsFromSettings(mockVault);

    expect(mockVault.createFolder).not.toHaveBeenCalled();
  });

  it("migrates legacy prompt to file with correct content", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null) // Folder does not exist
      .mockReturnValueOnce(null) // File does not exist
      .mockReturnValueOnce({
        path: "SystemPrompts/Migrated Custom System Prompt.md",
      } as TFile); // File created

    await migrateSystemPromptsFromSettings(mockVault);

    expect(mockVault.create).toHaveBeenCalledWith(
      "SystemPrompts/Migrated Custom System Prompt.md",
      legacyPrompt
    );
  });

  it("trims whitespace from legacy prompt content", async () => {
    const legacyPrompt = "  This is a legacy system prompt.  \n\n";
    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        path: "SystemPrompts/Migrated Custom System Prompt.md",
      } as TFile);

    await migrateSystemPromptsFromSettings(mockVault);

    expect(mockVault.create).toHaveBeenCalledWith(
      "SystemPrompts/Migrated Custom System Prompt.md",
      "This is a legacy system prompt."
    );
  });

  it("adds frontmatter to migrated file", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    const mockFile = {
      path: "SystemPrompts/Migrated Custom System Prompt.md",
    } as TFile;

    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(mockFile);

    Object.setPrototypeOf(mockFile, TFile.prototype);

    await migrateSystemPromptsFromSettings(mockVault);

    expect(systemPromptUtils.ensurePromptFrontmatter).toHaveBeenCalledWith(
      mockFile,
      expect.objectContaining({
        title: "Migrated Custom System Prompt",
        content: legacyPrompt,
      })
    );
  });

  it("clears legacy userSystemPrompt from settings after migration", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    const mockFile = {
      path: "SystemPrompts/Migrated Custom System Prompt.md",
    } as TFile;

    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(mockFile);

    Object.setPrototypeOf(mockFile, TFile.prototype);

    await migrateSystemPromptsFromSettings(mockVault);

    expect(settingsModel.updateSetting).toHaveBeenCalledWith("userSystemPrompt", "");
  });

  it("sets migrated prompt as default", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    const mockFile = {
      path: "SystemPrompts/Migrated Custom System Prompt.md",
    } as TFile;

    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(mockFile);

    Object.setPrototypeOf(mockFile, TFile.prototype);

    await migrateSystemPromptsFromSettings(mockVault);

    expect(settingsModel.updateSetting).toHaveBeenCalledWith(
      "defaultSystemPromptTitle",
      "Migrated Custom System Prompt"
    );
  });

  it("reloads all prompts after migration", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    const mockFile = {
      path: "SystemPrompts/Migrated Custom System Prompt.md",
    } as TFile;

    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(mockFile);

    Object.setPrototypeOf(mockFile, TFile.prototype);

    await migrateSystemPromptsFromSettings(mockVault);

    expect(systemPromptUtils.loadAllSystemPrompts).toHaveBeenCalled();
  });

  it("skips file creation if migrated file already exists", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    const existingFile = {
      path: "SystemPrompts/Migrated Custom System Prompt.md",
    } as TFile;

    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null) // Folder does not exist
      .mockReturnValueOnce(existingFile); // File already exists

    await migrateSystemPromptsFromSettings(mockVault);

    expect(mockVault.create).not.toHaveBeenCalled();
    expect(logger.logInfo).toHaveBeenCalledWith(
      'File "Migrated Custom System Prompt" already exists, skipping legacy prompt migration'
    );
  });

  it("clears legacy field even when file exists", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    const existingFile = {
      path: "SystemPrompts/Migrated Custom System Prompt.md",
    } as TFile;

    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(existingFile);

    await migrateSystemPromptsFromSettings(mockVault);

    expect(settingsModel.updateSetting).toHaveBeenCalledWith("userSystemPrompt", "");
    expect(settingsModel.updateSetting).toHaveBeenCalledWith(
      "defaultSystemPromptTitle",
      "Migrated Custom System Prompt"
    );
  });

  it("logs success message after migration", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    const mockFile = {
      path: "SystemPrompts/Migrated Custom System Prompt.md",
    } as TFile;

    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(mockFile);

    Object.setPrototypeOf(mockFile, TFile.prototype);

    await migrateSystemPromptsFromSettings(mockVault);

    expect(logger.logInfo).toHaveBeenCalledWith(
      'Successfully migrated legacy userSystemPrompt to "Migrated Custom System Prompt"'
    );
  });

  it("handles errors gracefully", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    const error = new Error("Vault error");

    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (mockVault.createFolder as jest.Mock).mockRejectedValue(error);

    await migrateSystemPromptsFromSettings(mockVault);

    expect(logger.logError).toHaveBeenCalledWith(
      "Failed to migrate legacy userSystemPrompt:",
      error
    );
  });

  it("does not throw error on migration failure", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    const error = new Error("Vault error");

    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (mockVault.createFolder as jest.Mock).mockRejectedValue(error);

    await expect(migrateSystemPromptsFromSettings(mockVault)).resolves.not.toThrow();
  });

  it("sets correct timestamps for migrated prompt", async () => {
    const legacyPrompt = "This is a legacy system prompt.";
    const mockFile = {
      path: "SystemPrompts/Migrated Custom System Prompt.md",
    } as TFile;

    (settingsModel.getSettings as jest.Mock).mockReturnValue({
      userSystemPrompt: legacyPrompt,
    });
    (mockVault.getAbstractFileByPath as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(mockFile);

    Object.setPrototypeOf(mockFile, TFile.prototype);

    const beforeTime = Date.now();
    await migrateSystemPromptsFromSettings(mockVault);
    const afterTime = Date.now();

    expect(systemPromptUtils.ensurePromptFrontmatter).toHaveBeenCalledWith(
      mockFile,
      expect.objectContaining({
        title: "Migrated Custom System Prompt",
        content: legacyPrompt,
        lastUsedMs: 0,
      })
    );

    const callArgs = (systemPromptUtils.ensurePromptFrontmatter as jest.Mock).mock.calls[0][1];
    expect(callArgs.createdMs).toBeGreaterThanOrEqual(beforeTime);
    expect(callArgs.createdMs).toBeLessThanOrEqual(afterTime);
    expect(callArgs.modifiedMs).toBeGreaterThanOrEqual(beforeTime);
    expect(callArgs.modifiedMs).toBeLessThanOrEqual(afterTime);
  });
});
