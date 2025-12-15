import { ABORT_REASON, COMPOSER_OUTPUT_INSTRUCTIONS, ModelCapability } from "@/constants";
import { LayerToMessagesConverter } from "@/context/LayerToMessagesConverter";
import { logInfo } from "@/logger";
import { getSettings } from "@/settings/model";
import { ChatMessage } from "@/types/message";
import { extractChatHistory, findCustomModel, withSuppressedTokenWarnings } from "@/utils";
import { BaseChainRunner } from "./BaseChainRunner";
import { recordPromptPayload } from "./utils/promptPayloadRecorder";
import { ThinkBlockStreamer } from "./utils/ThinkBlockStreamer";
import { getModelKey } from "@/aiParams";
import { ActionBlockStreamer } from "./utils/ActionBlockStreamer";
import { ToolManager } from "@/tools/toolManager";
import {
  writeToFileTool,
  replaceInFileTool,
  deleteNoteTool,
  createFolderTool,
  deleteFolderTool,
  moveFileTool,
  moveFolderTool,
} from "@/tools/ComposerTools";

export class LLMChainRunner extends BaseChainRunner {
  /**
   * Construct messages array using envelope-based context (L1-L5 layers)
   * Requires context envelope - throws error if unavailable
   */
  private async constructMessages(userMessage: ChatMessage): Promise<any[]> {
    // Require envelope for LLM chain
    if (!userMessage.contextEnvelope) {
      throw new Error(
        "[LLMChainRunner] Context envelope is required but not available. Cannot proceed with LLM chain."
      );
    }

    logInfo("[LLMChainRunner] Using envelope-based context");

    // Get chat history from memory (L4)
    const memory = this.chainManager.memoryManager.getMemory();
    const memoryVariables = await memory.loadMemoryVariables({});
    const chatHistory = extractChatHistory(memoryVariables);

    const baseMessages = LayerToMessagesConverter.convert(userMessage.contextEnvelope, {
      includeSystemMessage: true,
      mergeUserContent: true,
      debug: false,
    });

    // Insert L4 (chat history) between system and user
    const messages: any[] = [];

    // Add system message (L1)
    const systemMessage = baseMessages.find((m) => m.role === "system");
    if (systemMessage) {
      messages.push(systemMessage);
    }

    // Add chat history (L4)
    for (const entry of chatHistory) {
      messages.push({ role: entry.role, content: entry.content });
    }

    const userMessageContent = baseMessages.find((m) => m.role === "user");
    if (userMessageContent) {
      const composerPrompt = `<OUTPUT_FORMAT>\n${COMPOSER_OUTPUT_INSTRUCTIONS}\n</OUTPUT_FORMAT>`;
      const finalUserText = `${userMessageContent.content}\n\n${composerPrompt}`;

      if (userMessage.content && Array.isArray(userMessage.content)) {
        const updatedContent = userMessage.content.map((item: any) => {
          if (item.type === "text") {
            return { ...item, text: finalUserText };
          }
          return item;
        });
        messages.push({
          role: "user",
          content: updatedContent,
        });
      } else {
        messages.push({
          role: "user",
          content: finalUserText,
        });
      }
    }

    return messages;
  }

  async run(
    userMessage: ChatMessage,
    abortController: AbortController,
    updateCurrentAiMessage: (message: string) => void,
    addMessage: (message: ChatMessage) => void,
    options: {
      debug?: boolean;
      ignoreSystemMessage?: boolean;
      updateLoading?: (loading: boolean) => void;
    }
  ): Promise<string> {
    // Check if the current model has reasoning capability
    const settings = getSettings();
    const modelKey = getModelKey();
    let excludeThinking = false;

    try {
      const currentModel = findCustomModel(modelKey, settings.activeModels);
      // Exclude thinking blocks if model doesn't have REASONING capability
      excludeThinking = !currentModel.capabilities?.includes(ModelCapability.REASONING);
    } catch (error) {
      // If we can't find the model, default to including thinking blocks
      logInfo(
        "Could not determine model capabilities, defaulting to include thinking blocks",
        error
      );
    }

    const streamer = new ThinkBlockStreamer(updateCurrentAiMessage, undefined, excludeThinking);

    try {
      // Construct messages using envelope or legacy approach
      const messages = await this.constructMessages(userMessage);

      // Record the payload for debugging (includes layered view if envelope available)
      const chatModel = this.chainManager.chatModelManager.getChatModel();
      const modelName = (chatModel as { modelName?: string } | undefined)?.modelName;
      recordPromptPayload({
        messages,
        modelName,
        contextEnvelope: userMessage.contextEnvelope,
      });

      logInfo("Final Request to AI:\n", messages);

      const actionStreamer = new ActionBlockStreamer(ToolManager, {
        writeToFile: writeToFileTool,
        replaceInFile: replaceInFileTool,
        deleteNote: deleteNoteTool,
        createFolder: createFolderTool,
        deleteFolder: deleteFolderTool,
        moveFile: moveFileTool,
        moveFolder: moveFolderTool,
      });

      // Stream with abort signal and handle writeToFile actions
      const chatStream = await withSuppressedTokenWarnings<AsyncIterable<any>>(() =>
        this.chainManager.chatModelManager.getChatModel().stream(messages, {
          signal: abortController.signal,
        })
      );

      for await (const chunk of chatStream) {
        if (abortController.signal.aborted) {
          logInfo("Stream iteration aborted", { reason: abortController.signal.reason });
          break;
        }
        for await (const processedChunk of actionStreamer.processChunk(chunk)) {
          streamer.processChunk(processedChunk);
        }
      }
    } catch (error: any) {
      // Check if the error is due to abort signal
      if (error.name === "AbortError" || abortController.signal.aborted) {
        logInfo("Stream aborted by user", { reason: abortController.signal.reason });
        // Don't show error message for user-initiated aborts
      } else {
        await this.handleError(error, streamer.processErrorChunk.bind(streamer));
      }
    }

    // Always return the response, even if partial
    const result = streamer.close();

    const responseMetadata = {
      wasTruncated: result.wasTruncated,
      tokenUsage: result.tokenUsage ?? undefined,
    };

    // Only skip saving if it's a new chat (clearing everything)
    if (abortController.signal.aborted && abortController.signal.reason === ABORT_REASON.NEW_CHAT) {
      updateCurrentAiMessage("");
      return "";
    }

    await this.handleResponse(
      result.content,
      userMessage,
      abortController,
      addMessage,
      updateCurrentAiMessage,
      undefined,
      undefined,
      responseMetadata
    );

    return result.content;
  }
}
