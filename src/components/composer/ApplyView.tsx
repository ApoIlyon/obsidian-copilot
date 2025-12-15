import { cn } from "@/lib/utils";
import { logError } from "@/logger";
import { Change, diffWords } from "diff";
import { Check, X as XIcon } from "lucide-react";
import { App, ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import React, { useRef, memo } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../ui/button";
import { useState } from "react";
import { getChangeBlocks } from "@/composerUtils";
import { ApplyViewResult } from "@/types";
import { ensureFolderExists } from "@/utils";

export const APPLY_VIEW_TYPE = "obsidian-copilot-apply-view";

export interface ApplyViewState {
  changes: Change[];
  path: string;
  resultCallback?: (result: ApplyViewResult) => void;
  applyAllCallback?: (result: ApplyViewResult) => void;
}

// Extended Change interface to track user acceptance
interface ExtendedChange extends Change {
  accepted: boolean | null;
}

export class ApplyView extends ItemView {
  private root: ReturnType<typeof createRoot> | null = null;
  private state: ApplyViewState | null = null;
  private result: ApplyViewResult | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return APPLY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Preview Changes";
  }

  async setState(state: ApplyViewState) {
    this.state = state;
    this.render();
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }

    this.state?.resultCallback?.(this.result ? this.result : "aborted");
  }

  private render() {
    if (!this.state) return;

    // The second child is the actual content of the view, and the first child is the title of the view
    // NOTE: While no official documentation is found, this seems like a standard pattern across community plugins.
    const contentEl = this.containerEl.children[1];
    contentEl.empty();

    const rootEl = contentEl.createDiv();
    if (!this.root) {
      this.root = createRoot(rootEl);
    }

    // Pass a close function that takes a result
    this.root.render(
      <ApplyViewRoot
        app={this.app}
        state={this.state}
        close={(result) => {
          this.result = result;
          this.leaf.detach();
        }}
      />
    );
  }
}

interface ApplyViewRootProps {
  app: App;
  state: ApplyViewState;
  close: (result: ApplyViewResult) => void;
}

// Convert renderWordDiff to a React component
const WordDiff = memo(({ oldLine, newLine }: { oldLine: string; newLine: string }) => {
  const wordDiff = diffWords(oldLine, newLine);
  return (
    <>
      {wordDiff.map((part, idx) => {
        if (part.added) {
          return (
            <span key={idx} className="tw-text-success">
              {part.value}
            </span>
          );
        }
        if (part.removed) {
          return (
            <span key={idx} className="tw-text-error tw-line-through">
              {part.value}
            </span>
          );
        }
        return <span key={idx}>{part.value}</span>;
      })}
    </>
  );
});

WordDiff.displayName = "WordDiff";

const ApplyViewRoot: React.FC<ApplyViewRootProps> = ({ app, state, close }) => {
  const [diff, setDiff] = useState<ExtendedChange[]>(() => {
    return state.changes.map((change) => ({
      ...change,
      accepted: null, // Start with null (undecided)
    }));
  });

  const [isManageMode, setIsManageMode] = useState(false);
  const [showResult, setShowResult] = useState(false);

  // Group changes into blocks for better UI presentation
  const changeBlocks = getChangeBlocks(diff);

  // Add refs to track change blocks
  const blockRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Add defensive check for state after hooks
  if (!state || !state.changes) {
    logError("Invalid state:", state);
    return (
      <div className="tw-flex tw-h-full tw-flex-col tw-items-center tw-justify-center">
        <div className="tw-text-error">Error: Invalid state - missing changes</div>
        <Button onClick={() => close("failed")} className="tw-mt-4">
          Close
        </Button>
      </div>
    );
  }

  const handleAccept = async () => {
    try {
      const updatedDiff = diff.map((change) =>
        change.accepted === null ? { ...change, accepted: true } : change
      );

      const result = await applyDecidedChangesToFile(updatedDiff);
      close(result ? "accepted" : "failed");
    } catch (error) {
      logError("Error applying changes:", error);
      new Notice(`Error applying changes: ${error.message}`);
      close("failed");
    }
  };

  const handleReject = async () => {
    try {
      const updatedDiff = diff.map((change) =>
        change.accepted === null ? { ...change, accepted: false } : change
      );

      const result = await applyDecidedChangesToFile(updatedDiff);
      close(result ? "rejected" : "failed");
    } catch (error) {
      logError("Error applying changes:", error);
      new Notice(`Error applying changes: ${error.message}`);
      close("failed");
    }
  };

  const getFile = async (file_path: string) => {
    const file = app.vault.getAbstractFileByPath(file_path);
    if (file) {
      return file;
    }
    // Create the folder if it doesn't exist (supports nested paths)
    if (file_path.includes("/")) {
      const folderPath = file_path.split("/").slice(0, -1).join("/");
      await ensureFolderExists(folderPath);
    }
    return await app.vault.create(file_path, "");
  };

  const buildContentFromDiff = (changes: ExtendedChange[]) => {
    return changes
      .filter((change) => {
        if (change.added) return change.accepted === true;
        if (change.removed) return change.accepted === false;
        return true;
      })
      .map((change) => change.value)
      .join("");
  };

  const buildPreviewResultFromDiff = (changes: ExtendedChange[]) => {
    return changes
      .filter((change) => {
        if (change.added) return change.accepted !== false;
        if (change.removed) return change.accepted === false;
        return true;
      })
      .map((change) => change.value)
      .join("");
  };

  const applyDecidedChangesToFile = async (updatedDiff: ExtendedChange[]) => {
    const newContent = buildContentFromDiff(updatedDiff);

    const file = await getFile(state.path);
    if (!file || !(file instanceof TFile)) {
      logError("Error in getting file", state.path);
      new Notice("Failed to create file");
      return false;
    }

    await app.vault.modify(file, newContent);
    new Notice("Changes applied successfully");
    return true;
  };

  const handleAcceptAll = async () => {
    try {
      const updatedDiff = diff.map((change) => {
        if (change.added) {
          return {
            ...change,
            accepted: true,
          };
        }
        if (change.removed) {
          return {
            ...change,
            accepted: false,
          };
        }
        return change;
      });

      const result = await applyDecidedChangesToFile(updatedDiff);
      const mode: ApplyViewResult = result ? "accepted" : "failed";
      if (mode !== "failed") {
        state.applyAllCallback?.(mode);
      }
      close(mode);
    } catch (error) {
      logError("Error applying changes:", error);
      new Notice(`Error applying changes: ${error.message}`);
      close("failed");
    }
  };

  const handleRejectAll = async () => {
    try {
      const updatedDiff = diff.map((change) => {
        if (change.added || change.removed) {
          return {
            ...change,
            accepted: false,
          };
        }
        return change;
      });

      const result = await applyDecidedChangesToFile(updatedDiff);
      const mode: ApplyViewResult = result ? "rejected" : "failed";
      if (mode !== "failed") {
        state.applyAllCallback?.(mode);
      }
      close(mode);
    } catch (error) {
      logError("Error rejecting all changes:", error);
      new Notice(`Error rejecting changes: ${error.message}`);
      close("failed");
    }
  };

  // Function to focus on the next change block or scroll to top if it's the last block
  const focusNextChangeBlock = (currentBlockIndex: number) => {
    if (!changeBlocks) return;

    // Find the next block with changes that is undecided
    let nextBlockIndex = -1;
    for (let i = currentBlockIndex + 1; i < changeBlocks.length; i++) {
      const block = changeBlocks[i];
      const hasChanges = block.some((change) => change.added || change.removed);
      const isUndecided = block.some(
        (change) => (change.added || change.removed) && (change as ExtendedChange).accepted === null
      );

      if (hasChanges && isUndecided) {
        nextBlockIndex = i;
        break;
      }
    }

    // If there's a next block, scroll to it
    if (nextBlockIndex !== -1 && blockRefs.current[nextBlockIndex]) {
      blockRefs.current[nextBlockIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  // Accept a block of changes
  const acceptBlock = (blockIndex: number) => {
    setDiff((prevDiff) => {
      const newDiff = [...prevDiff];
      const block = changeBlocks?.[blockIndex];

      if (!block) return newDiff;

      // Find the indices of the changes in this block
      block.forEach((blockChange) => {
        const index = newDiff.findIndex((change) => change === blockChange);
        if (index !== -1) {
          newDiff[index] = {
            ...newDiff[index],
            accepted: true,
          };
        }
      });

      return newDiff;
    });

    // Focus on the next change block after state update
    setTimeout(() => focusNextChangeBlock(blockIndex), 0);
  };

  // Reject a block of changes
  const rejectBlock = (blockIndex: number) => {
    setDiff((prevDiff) => {
      const newDiff = [...prevDiff];
      const block = changeBlocks?.[blockIndex];

      if (!block) return newDiff;

      // Find the indices of the changes in this block
      block.forEach((blockChange) => {
        const index = newDiff.findIndex((change) => change === blockChange);
        if (index !== -1) {
          newDiff[index] = {
            ...newDiff[index],
            accepted: false,
          };
        }
      });

      return newDiff;
    });

    // Focus on the next change block after state update
    setTimeout(() => focusNextChangeBlock(blockIndex), 0);
  };

  const originalContent = diff
    .filter((change) => !change.added)
    .map((change) => change.value)
    .join("");

  const previewContent = buildPreviewResultFromDiff(diff);

  const proposedContent = diff
    .filter((change) => !change.removed)
    .map((change) => change.value)
    .join("");

  const renderRightPane = () => {
    if (!isManageMode) {
      return (
        <div className="tw-whitespace-pre-wrap tw-font-mono tw-text-sm tw-text-normal">
          {proposedContent}
        </div>
      );
    }

    return changeBlocks?.map((block, blockIndex) => {
      const hasChanges = block.some((change) => change.added || change.removed);

      const blockStatus = hasChanges
        ? block.every(
            (change) =>
              (!change.added && !change.removed) || (change as ExtendedChange).accepted === true
          )
          ? "accepted"
          : block.every(
                (change) =>
                  (!change.added && !change.removed) ||
                  (change as ExtendedChange).accepted === false
              )
            ? "rejected"
            : "undecided"
        : "unchanged";

      return (
        <div
          key={blockIndex}
          ref={(el) => (blockRefs.current[blockIndex] = el)}
          className={cn("tw-mb-4 tw-overflow-hidden tw-rounded-md")}
        >
          {blockStatus === "accepted" ? (
            <div className="tw-flex-1 tw-whitespace-pre-wrap tw-px-2 tw-py-1 tw-font-mono tw-text-sm tw-text-normal">
              {block
                .filter((change) => !change.removed)
                .map((change, idx) => (
                  <div key={idx}>{change.value}</div>
                ))}
            </div>
          ) : blockStatus === "rejected" ? (
            <div className="tw-flex-1 tw-whitespace-pre-wrap tw-px-2 tw-py-1 tw-font-mono tw-text-sm tw-text-normal">
              {block
                .filter((change) => !change.added)
                .map((change, idx) => (
                  <div key={idx}>{change.value}</div>
                ))}
            </div>
          ) : (
            block.map((change, changeIndex) => {
              if (change.added) {
                const removedIdx = block.findIndex((c, i) => c.removed && i !== changeIndex);
                if (removedIdx !== -1) {
                  const removedLine = block[removedIdx].value;
                  return (
                    <div key={`${blockIndex}-${changeIndex}`} className="tw-relative">
                      <div className="tw-flex-1 tw-whitespace-pre-wrap tw-px-2 tw-py-1 tw-font-mono tw-text-sm">
                        <WordDiff oldLine={removedLine} newLine={change.value} />
                      </div>
                    </div>
                  );
                }
              }
              if (change.removed) {
                const addedIdx = block.findIndex((c, i) => c.added && i !== changeIndex);
                if (addedIdx !== -1) {
                  return null;
                }
              }
              return (
                <div key={`${blockIndex}-${changeIndex}`} className="tw-relative">
                  <div
                    className={cn(
                      "tw-flex-1 tw-whitespace-pre-wrap tw-px-2 tw-py-1 tw-font-mono tw-text-sm",
                      {
                        "tw-text-success": change.added,
                        "tw-text-error": change.removed,
                        "tw-text-normal": !change.added && !change.removed,
                        "tw-line-through": change.removed,
                      }
                    )}
                  >
                    {change.value}
                  </div>
                </div>
              );
            })
          )}

          {hasChanges && blockStatus === "undecided" && (
            <div className="tw-flex tw-items-center tw-justify-end tw-border-[0px] tw-border-t tw-border-solid tw-border-border tw-p-2">
              <div className="tw-flex tw-items-center tw-gap-2">
                <Button variant="destructive" size="sm" onClick={() => rejectBlock(blockIndex)}>
                  <XIcon className="tw-size-4" />
                  Reject
                </Button>
                <Button variant="success" size="sm" onClick={() => acceptBlock(blockIndex)}>
                  <Check className="tw-size-4" />
                  Accept
                </Button>
              </div>
            </div>
          )}

          {hasChanges && (blockStatus === "accepted" || blockStatus === "rejected") && (
            <div className="tw-flex tw-items-center tw-justify-end tw-border-[0px] tw-border-t tw-border-solid tw-border-border tw-p-2">
              <div className="tw-flex tw-items-center tw-gap-2">
                <div className="tw-mr-2 tw-text-sm tw-font-medium">
                  {blockStatus === "accepted" ? (
                    <div className="tw-flex tw-items-center tw-gap-1 tw-text-success">
                      <Check className="tw-size-4" />
                      <div>Accepted</div>
                    </div>
                  ) : (
                    <div className="tw-flex tw-items-center tw-gap-1 tw-text-error">
                      <XIcon className="tw-size-4" />
                      <div>Rejected</div>
                    </div>
                  )}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setDiff((prevDiff) => {
                      const newDiff = [...prevDiff];
                      const block = changeBlocks?.[blockIndex];

                      if (!block) return newDiff;

                      block.forEach((blockChange) => {
                        const index = newDiff.findIndex((change) => change === blockChange);
                        if (index !== -1) {
                          newDiff[index] = {
                            ...newDiff[index],
                            accepted: null,
                          };
                        }
                      });

                      return newDiff;
                    });
                  }}
                >
                  Revert
                </Button>
              </div>
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="tw-relative tw-flex tw-h-full tw-flex-col">
      <div className="tw-fixed tw-bottom-4 tw-left-1/2 tw-z-[9999] tw-flex -tw-translate-x-1/2 tw-gap-2 tw-rounded-md tw-border tw-border-solid tw-border-border tw-bg-secondary tw-p-2 tw-shadow-lg tw-transition-opacity tw-duration-200">
        <Button variant="destructive" size="sm" onClick={handleReject}>
          <XIcon className="tw-size-4" />
          Reject
        </Button>
        <Button variant="success" size="sm" onClick={handleAccept}>
          <Check className="tw-size-4" />
          Accept
        </Button>
        <Button variant="destructive" size="sm" onClick={handleRejectAll}>
          <XIcon className="tw-size-4" />
          Reject All
        </Button>
        <Button variant="success" size="sm" onClick={handleAcceptAll}>
          <Check className="tw-size-4" />
          Accept All
        </Button>
      </div>
      <div className="tw-flex tw-items-center tw-justify-between tw-border-b tw-border-solid tw-border-border tw-p-2 tw-text-sm tw-font-medium">
        <div className="tw-flex tw-flex-1 tw-items-center tw-gap-4">
          <span className="tw-flex-1 tw-truncate">{state.path}</span>
          {isManageMode ? (
            <>
              <div className="tw-flex tw-items-center tw-gap-1">
                <button
                  type="button"
                  className={cn(
                    "tw-text-xs tw-uppercase tw-tracking-wide tw-text-muted",
                    !showResult && "tw-font-semibold tw-text-normal"
                  )}
                  onClick={() => setShowResult(false)}
                >
                  Original
                </button>
                <span className="tw-text-xs tw-text-muted">→</span>
                <button
                  type="button"
                  className={cn(
                    "tw-text-xs tw-uppercase tw-tracking-wide tw-text-muted",
                    showResult && "tw-font-semibold tw-text-normal"
                  )}
                  onClick={() => setShowResult(true)}
                >
                  Result
                </button>
              </div>
              <span className="tw-text-xs tw-uppercase tw-tracking-wide tw-text-muted">
                Proposed
              </span>
            </>
          ) : (
            <>
              <span className="tw-text-xs tw-uppercase tw-tracking-wide tw-text-muted">
                Original
              </span>
              <span className="tw-text-xs tw-uppercase tw-tracking-wide tw-text-muted">
                Proposed
              </span>
            </>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="tw-ml-4"
          onClick={() =>
            setIsManageMode((prev) => {
              const next = !prev;
              if (!next) {
                setShowResult(false);
              }
              return next;
            })
          }
        >
          {isManageMode ? "Hide Controls" : "Manage Changes"}
        </Button>
      </div>

      <div className="tw-flex tw-flex-1 tw-overflow-hidden">
        <div className="tw-flex-1 tw-overflow-auto tw-border-r tw-border-solid tw-border-border tw-p-2">
          <div className="tw-whitespace-pre-wrap tw-font-mono tw-text-sm tw-text-normal">
            {isManageMode && showResult ? previewContent : originalContent}
          </div>
        </div>

        <div className="tw-flex-1 tw-overflow-auto tw-p-2">{renderRightPane()}</div>
      </div>
    </div>
  );
};
