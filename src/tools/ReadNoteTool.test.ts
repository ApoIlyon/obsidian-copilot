import { StructuredTool } from "@langchain/core/tools";

const mockRead = jest.fn();

// Helper to invoke tool and parse JSON result
const invokeReadNoteTool = async (tool: StructuredTool, args: any) => {
  const result = await tool.invoke(args);
  return typeof result === "string" ? JSON.parse(result) : result;
};

class MockTFile {
  path: string;
  basename: string;
  extension: string;
  stat: { mtime: number };

  constructor(path: string) {
    this.path = path;
    const fileName = path.split("/").pop() || path;
    this.basename = fileName.replace(/\.[^/.]+$/, "");
    this.extension = fileName.includes(".") ? fileName.split(".").pop() || "" : "";
    this.stat = { mtime: Date.now() };
  }
}

jest.mock("obsidian", () => ({
  TFile: MockTFile,
}));

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

describe("readNoteTool", () => {
  let readNoteTool: StructuredTool;
  let originalApp: any;
  let getAbstractFileByPathMock: jest.Mock;
  let getFilesMock: jest.Mock;
  let getFirstLinkpathDestMock: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();

    originalApp = global.app;
    getAbstractFileByPathMock = jest.fn();
    getFilesMock = jest.fn().mockReturnValue([]);
    getFirstLinkpathDestMock = jest.fn().mockReturnValue(null);
    mockRead.mockReset();
    mockRead.mockResolvedValue("");

    global.app = {
      vault: {
        getAbstractFileByPath: getAbstractFileByPathMock,
        getFiles: getFilesMock,
        read: mockRead,
      },
      metadataCache: {
        getFileCache: jest.fn(),
        getFirstLinkpathDest: getFirstLinkpathDestMock,
      },
      workspace: {
        getLeavesOfType: jest.fn().mockReturnValue([]),
        getActiveFile: jest.fn().mockReturnValue(null),
      },
    } as any;

    ({ readNoteTool } = await import("./NoteTools"));
  });

  afterEach(() => {
    global.app = originalApp;
  });

  it("returns the first chunk with follow-up metadata", async () => {
    const notePath = "Notes/test.md";
    const file = new MockTFile(notePath);
    getAbstractFileByPathMock.mockReturnValue(file);
    mockRead.mockResolvedValue(["## Heading", "Line 1", "Line 2"].join("\n"));

    const result = await invokeReadNoteTool(readNoteTool, { notePath });

    expect(result.notePath).toBe(notePath);
    expect(result.totalChunks).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.content).toBe(["## Heading", "Line 1", "Line 2"].join("\n"));
  });

  it("respects the requested chunk index", async () => {
    const notePath = "Notes/multi.md";
    const file = new MockTFile(notePath);
    getAbstractFileByPathMock.mockReturnValue(file);

    const lines = Array.from({ length: 210 }, (_, i) => `Line ${i + 1}`);
    mockRead.mockResolvedValue(lines.join("\n"));

    const result = await invokeReadNoteTool(readNoteTool, { notePath, chunkIndex: 1 });

    expect(result.chunkIndex).toBe(1);
    expect(result.content).toBe(lines.slice(200).join("\n"));
  });

  it("accepts chunkIndex provided as a string", async () => {
    const notePath = "Notes/string-index.md";
    const file = new MockTFile(notePath);
    getAbstractFileByPathMock.mockReturnValue(file);

    const lines = Array.from({ length: 205 }, (_, i) => `Line ${i + 1}`);
    mockRead.mockResolvedValue(lines.join("\n"));

    const result = await invokeReadNoteTool(readNoteTool, { notePath, chunkIndex: "1" as any });

    expect(result.chunkIndex).toBe(1);
    expect(result.content).toBe(lines.slice(200).join("\n"));
  });

  it("returns not_found when the note cannot be resolved", async () => {
    const notePath = "Notes/missing.md";
    getAbstractFileByPathMock.mockReturnValue(null);

    const result = await invokeReadNoteTool(readNoteTool, { notePath });

    expect(result).toEqual({
      notePath,
      status: "not_found",
      message: 'Note "Notes/missing.md" was not found or is not a readable file.',
    });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("returns not_found for section-only wiki link targets", async () => {
    const notePath = "[[#Setup]]";
    getAbstractFileByPathMock.mockReturnValue(null);
    getFirstLinkpathDestMock.mockReturnValue(null);
    getFilesMock.mockReturnValue([new MockTFile("Docs/Guide.md")]);

    const result = await invokeReadNoteTool(readNoteTool, { notePath });

    expect(result).toEqual({
      notePath,
      status: "not_found",
      message: 'Note "[[#Setup]]" was not found or is not a readable file.',
    });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("returns not_found for empty wiki link targets", async () => {
    const notePath = "[[]]";
    getAbstractFileByPathMock.mockReturnValue(null);
    getFirstLinkpathDestMock.mockReturnValue(null);
    getFilesMock.mockReturnValue([new MockTFile("Docs/Guide.md")]);

    const result = await invokeReadNoteTool(readNoteTool, { notePath });

    expect(result).toEqual({
      notePath,
      status: "not_found",
      message: 'Note "[[]]" was not found or is not a readable file.',
    });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("returns invalid_path when notePath starts with a leading slash", async () => {
    const result = await invokeReadNoteTool(readNoteTool, { notePath: "/Projects/note.md" });

    expect(result).toEqual({
      notePath: "/Projects/note.md",
      status: "invalid_path",
      message: "Provide the note path relative to the vault root without a leading slash.",
    });
    expect(getAbstractFileByPathMock).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("surfaces linked note candidates including duplicate basenames", async () => {
    const notePath = "Notes/source.md";
    const file = new MockTFile(notePath);
    const candidatePrimary = new MockTFile("Projects/Project Plan.md");
    const candidateDuplicate = new MockTFile("Archive/Project Plan.md");

    getAbstractFileByPathMock.mockReturnValue(file);
    getFirstLinkpathDestMock.mockImplementation((link: string) =>
      link === "Project Plan" ? candidatePrimary : null
    );
    getFilesMock.mockReturnValue([candidatePrimary, candidateDuplicate, file]);
    mockRead.mockResolvedValue("Intro [[Project Plan]] details");

    const result = await invokeReadNoteTool(readNoteTool, { notePath });

    expect(result.linkedNotes).toEqual([
      {
        linkText: "Project Plan",
        displayText: "Project Plan",
        section: undefined,
        candidates: [
          { path: candidatePrimary.path, title: candidatePrimary.basename },
          { path: candidateDuplicate.path, title: candidateDuplicate.basename },
        ],
      },
    ]);
  });

  it("captures alias and section metadata for wiki links", async () => {
    const notePath = "Notes/source.md";
    const file = new MockTFile(notePath);
    const guideFile = new MockTFile("Docs/Guide.md");

    getAbstractFileByPathMock.mockReturnValue(file);
    getFirstLinkpathDestMock.mockImplementation((link: string) =>
      link === "Docs/Guide" ? guideFile : null
    );
    getFilesMock.mockReturnValue([guideFile, file]);
    mockRead.mockResolvedValue("See [[Docs/Guide#Setup|Quick Start]] for steps.");

    const result = await invokeReadNoteTool(readNoteTool, { notePath });

    expect(result.linkedNotes).toEqual([
      {
        linkText: "Docs/Guide",
        displayText: "Quick Start",
        section: "Setup",
        candidates: [{ path: guideFile.path, title: guideFile.basename }],
      },
    ]);
  });

  it("resolves note paths without an explicit extension", async () => {
    const rawPath = "Notes/extensionless";
    const file = new MockTFile(`${rawPath}.md`);

    getAbstractFileByPathMock.mockImplementation((path: string) => {
      if (path === rawPath) {
        return null;
      }
      if (path === `${rawPath}.md`) {
        return file;
      }
      return null;
    });

    mockRead.mockResolvedValue("Content");

    const result = await invokeReadNoteTool(readNoteTool, { notePath: rawPath });

    expect(result.notePath).toBe(file.path);
    expect(result.chunkIndex).toBe(0);
    expect(mockRead).toHaveBeenCalledWith(file);
  });

  it("resolves canvas paths without an explicit extension", async () => {
    const rawPath = "Maps/architecture";
    const canvasFile = new MockTFile(`${rawPath}.canvas`);

    getAbstractFileByPathMock.mockImplementation((path: string) => {
      if (path === rawPath) {
        return null;
      }
      if (path === `${rawPath}.canvas`) {
        return canvasFile;
      }
      return null;
    });
    mockRead.mockResolvedValue('{"nodes":[],"edges":[]}');

    const result = await invokeReadNoteTool(readNoteTool, { notePath: rawPath });

    expect(result.notePath).toBe(canvasFile.path);
    expect(result.fileType).toBe("canvas");
    expect(mockRead).toHaveBeenCalledWith(canvasFile);
  });

  it("resolves wiki-linked notes via metadata without active note context", async () => {
    const requestedPath = "Project Plan";
    const targetFile = new MockTFile("Projects/Project Plan.md");

    getAbstractFileByPathMock.mockReturnValue(null);
    getFirstLinkpathDestMock.mockImplementation((link: string, source: string) => {
      if (link === requestedPath && source === "") {
        return targetFile;
      }
      return null;
    });
    mockRead.mockResolvedValue("Content");

    const result = await invokeReadNoteTool(readNoteTool, { notePath: requestedPath });

    expect(result.notePath).toBe(targetFile.path);
    expect(mockRead).toHaveBeenCalledWith(targetFile);
    expect(getFirstLinkpathDestMock).toHaveBeenCalledWith(requestedPath, "");
  });

  it("falls back to a unique basename match when metadata resolution fails", async () => {
    const requestedPath = "Solo Note";
    const targetFile = new MockTFile("Area/Solo Note.md");

    getAbstractFileByPathMock.mockReturnValue(null);
    getFirstLinkpathDestMock.mockReturnValue(null);
    getFilesMock.mockReturnValue([targetFile]);
    mockRead.mockResolvedValue("Content");

    const result = await invokeReadNoteTool(readNoteTool, { notePath: requestedPath });

    expect(result.notePath).toBe(targetFile.path);
    expect(mockRead).toHaveBeenCalledWith(targetFile);
  });

  it("returns not_unique when multiple notes share the same title", async () => {
    const requestedPath = "Project Plan";
    const projectFile = new MockTFile("Projects/Project Plan.md");
    const archiveFile = new MockTFile("Archive/Project Plan.md");

    getAbstractFileByPathMock.mockReturnValue(null);
    getFirstLinkpathDestMock.mockReturnValue(null);
    getFilesMock.mockReturnValue([projectFile, archiveFile]);

    const result = await invokeReadNoteTool(readNoteTool, { notePath: requestedPath });

    expect(result).toEqual({
      notePath: requestedPath,
      status: "not_unique",
      message: 'Multiple notes match "Project Plan". Provide a more specific path.',
      candidates: [
        { path: projectFile.path, title: projectFile.basename },
        { path: archiveFile.path, title: archiveFile.basename },
      ],
    });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("matches a unique partial path when multiple basenames exist", async () => {
    const requestedPath = "Projects/Project Plan";
    const targetFile = new MockTFile("Projects/Project Plan.md");
    const duplicateFile = new MockTFile("Archive/Project Plan.md");

    getAbstractFileByPathMock.mockReturnValue(null);
    getFirstLinkpathDestMock.mockReturnValue(null);
    getFilesMock.mockReturnValue([targetFile, duplicateFile]);
    mockRead.mockResolvedValue("Content");

    const result = await invokeReadNoteTool(readNoteTool, { notePath: requestedPath });

    expect(result.notePath).toBe(targetFile.path);
    expect(mockRead).toHaveBeenCalledWith(targetFile);
  });

  it("returns canvas structural metadata when reading canvas files", async () => {
    const notePath = "Maps/flow.canvas";
    const canvasFile = new MockTFile(notePath);
    getAbstractFileByPathMock.mockReturnValue(canvasFile);
    mockRead.mockResolvedValue(
      JSON.stringify(
        {
          nodes: [
            { id: "n1", type: "text", text: "Start", x: 0, y: 0, width: 240, height: 80 },
            { id: "n2", type: "text", text: "End", x: 320, y: 0, width: 240, height: 80 },
          ],
          edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
        },
        null,
        2
      )
    );

    const result = await invokeReadNoteTool(readNoteTool, { notePath });

    expect(result.fileType).toBe("canvas");
    expect(result.canvasSummary).toEqual({
      nodeCount: 2,
      edgeCount: 1,
      invalidEdgeCount: 0,
      nodeTypeCounts: { text: 2 },
    });
  });
});
