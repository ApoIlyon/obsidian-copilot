import { ToolManager } from "@/tools/toolManager";
import { ToolResultFormatter } from "@/tools/ToolResultFormatter";

/**
 * ActionBlockStreamer processes streaming chunks to detect and handle writeToFile blocks.
 *
 * 1. Accumulates chunks in a buffer
 * 2. Detects complete writeToFile blocks
 * 3. Calls the writeToFile tool when a complete block is found
 * 4. Returns chunks as-is otherwise
 */
export class ActionBlockStreamer {
  private buffer = "";

  constructor(
    private toolManager: typeof ToolManager,
    private tools: {
      writeToFile?: any;
      replaceInFile?: any;
      deleteNote?: any;
      createFolder?: any;
      deleteFolder?: any;
      moveFile?: any;
      moveFolder?: any;
    }
  ) {}

  private findCompleteBlock(str: string) {
    const tagNames = [
      "writeToFile",
      "replaceInFile",
      "deleteNote",
      "createFolder",
      "deleteFolder",
      "moveFile",
      "moveFolder",
    ];
    const regex = new RegExp(`<(${tagNames.join("|")})>[\\s\\S]*?<\\/\\1>`);
    const match = str.match(regex);

    if (!match || match.index === undefined) {
      return null;
    }

    return {
      block: match[0],
      toolName: match[1] as
        | "writeToFile"
        | "replaceInFile"
        | "deleteNote"
        | "createFolder"
        | "deleteFolder"
        | "moveFile"
        | "moveFolder",
      endIdx: match.index + match[0].length,
    };
  }

  private extractTagValue(block: string, tag: string): string | undefined {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
    const match = block.match(regex);
    return match ? match[1].trim() : undefined;
  }

  private parseBoolean(value: string | undefined): boolean | undefined {
    if (value == null) {
      return undefined;
    }
    const v = value.trim().toLowerCase();
    if (v === "true") {
      return true;
    }
    if (v === "false") {
      return false;
    }
    return undefined;
  }

  async *processChunk(chunk: any): AsyncGenerator<any, void, unknown> {
    // Handle different chunk formats
    let chunkContent = "";

    // Handle Claude thinking model array-based content
    if (Array.isArray(chunk.content)) {
      for (const item of chunk.content) {
        if (item.type === "text" && item.text != null) {
          chunkContent += item.text;
        }
      }
    }
    // Handle standard string content
    else if (chunk.content != null) {
      chunkContent = chunk.content;
    }

    // Add to buffer
    if (chunkContent) {
      this.buffer += chunkContent;
    }

    // Yield the original chunk as-is
    yield chunk;

    let blockInfo = this.findCompleteBlock(this.buffer);

    while (blockInfo) {
      const { block, toolName, endIdx } = blockInfo as {
        block: string;
        toolName:
          | "writeToFile"
          | "replaceInFile"
          | "deleteNote"
          | "createFolder"
          | "deleteFolder"
          | "moveFile"
          | "moveFolder";
        endIdx: number;
      };

      const tool = this.tools[toolName];
      const args: any = {};

      if (toolName === "writeToFile") {
        args.path = this.extractTagValue(block, "path");
        args.content = this.extractTagValue(block, "content");
      } else if (toolName === "replaceInFile") {
        args.path = this.extractTagValue(block, "path");
        args.diff = this.extractTagValue(block, "diff");
      } else if (toolName === "deleteNote") {
        args.path = this.extractTagValue(block, "path");
      } else if (toolName === "createFolder") {
        args.path = this.extractTagValue(block, "path");
      } else if (toolName === "deleteFolder") {
        args.path = this.extractTagValue(block, "path");
        const recursive = this.parseBoolean(this.extractTagValue(block, "recursive"));
        if (recursive !== undefined) {
          args.recursive = recursive;
        }
      } else if (toolName === "moveFile" || toolName === "moveFolder") {
        args.fromPath = this.extractTagValue(block, "fromPath");
        args.toPath = this.extractTagValue(block, "toPath");
        const createMissingFolders = this.parseBoolean(
          this.extractTagValue(block, "createMissingFolders")
        );
        if (createMissingFolders !== undefined) {
          args.createMissingFolders = createMissingFolders;
        }
      }

      try {
        if (!tool) {
          throw new Error(`Tool not available for tag: ${toolName}`);
        }

        const result = await this.toolManager.callTool(tool, args);
        const formattedResult = ToolResultFormatter.format(toolName, result);
        yield { ...chunk, content: `\n${formattedResult}\n` };
      } catch (err: any) {
        yield { ...chunk, content: `\nError: ${err?.message || err}\n` };
      }

      this.buffer = this.buffer.substring(endIdx);

      blockInfo = this.findCompleteBlock(this.buffer);
    }
  }
}
