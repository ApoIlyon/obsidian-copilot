/**
 * Obsidian Modal shell for importing Copilot settings from an encrypted Setup URI.
 * Renders the ImportStepperContent React component inside the modal.
 *
 * Business logic methods (persist, reload, notify) are kept on this class
 * and passed as callbacks to the React component, ensuring async operations
 * are not interrupted by React unmount.
 */

import { ImportStepperContent } from "@/components/setup-uri/ImportStepperContent";
import { persistSettings } from "@/services/settingsPersistence";
import type { CopilotSettings } from "@/settings/model";
import { getSettings } from "@/settings/model";
import { App, Modal, Notice } from "obsidian";
import React from "react";
import { createRoot, Root } from "react-dom/client";

export class SetupUriImportModal extends Modal {
  private root?: Root;
  /** Optional pre-filled payload from the protocol handler. */
  private readonly prefillPayload?: string;
  /** Injected saveData callback to avoid reaching into app.plugins at runtime. */
  private readonly saveDataFn: (data: CopilotSettings) => Promise<void>;

  /**
   * @param app Obsidian App instance.
   * @param saveData Callback to persist data.json (typically `plugin.saveData`).
   * @param prefillPayload When provided (from protocol handler), the URI
   *   textarea is pre-filled and readonly.
   */
  constructor(
    app: App,
    saveData: (data: CopilotSettings) => Promise<void>,
    prefillPayload?: string
  ) {
    super(app);
    this.saveDataFn = saveData;
    this.prefillPayload = prefillPayload;
  }

  onOpen(): void {
    // @ts-ignore — setTitle is available in Obsidian API
    this.setTitle("Import Setup URI");

    this.root = createRoot(this.contentEl);
    this.root.render(
      <ImportStepperContent
        prefillPayload={this.prefillPayload}
        onPersistSettings={(settings) => this.persistImportedSettings(settings)}
        onReloadPlugin={() => this.reloadPlugin()}
        onNotifyManualCopy={(folders) => this.notifyManualCopyNeeded(folders)}
        onClose={() => this.close()}
      />
    );
  }

  onClose(): void {
    this.root?.unmount();
    this.root = undefined;
  }

  /**
   * Persist imported settings to disk and await completion before reload.
   *
   * Reason: applySetupUri() returns sanitized settings without calling
   * setSettings(), so there is no subscriber-triggered save. This is the
   * single persistence path, eliminating the previous double-save race.
   */
  private async persistImportedSettings(settings: CopilotSettings): Promise<void> {
    // Reason: Use the unified persistence path so secrets are written to
    // keychain (when available) instead of being encrypted into data.json.
    // Pass current settings as prevSettings so deleted models get cleaned up from keychain.
    await persistSettings(settings, (data) => this.saveDataFn(data), getSettings());
  }

  /**
   * Show a reminder about vault files that are NOT included in Setup URI.
   *
   * Reason: custom commands, system prompts, and memory files live in the vault
   * filesystem, not in plugin settings. Users must copy these folders
   * manually from the source vault.
   */
  private notifyManualCopyNeeded(imported: {
    customPromptsFolder?: string;
    userSystemPromptsFolder?: string;
    memoryFolderName?: string;
  }): void {
    const folders = [
      imported.customPromptsFolder,
      imported.userSystemPromptsFolder,
      imported.memoryFolderName,
    ].filter(Boolean);

    if (folders.length === 0) return;

    const folderList = folders.map((f) => `  \u2022 ${f}`).join("\n");
    new Notice(
      "Note: Custom commands, system prompts, and memory files are not " +
        "included in the Setup URI. To complete the migration, manually " +
        `copy these folders from the source vault:\n${folderList}`,
      15_000
    );
  }

  /** Reload the Copilot plugin to apply imported settings. */
  private async reloadPlugin(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugins = (this.app as any).plugins;
      await plugins.disablePlugin("copilot");
      await plugins.enablePlugin("copilot");
      new Notice("Plugin reloaded successfully.");
    } catch {
      new Notice("Please restart Obsidian to apply the imported settings.");
    }
  }
}
