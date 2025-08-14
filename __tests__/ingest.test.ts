import { fileIngester } from "../src/ingest";
import * as fs from "fs";
import * as path from "path";
import { stateManager } from "../src/state";

// Mock the state manager
jest.mock("../src/state");

describe("FileIngester", () => {
  const testDir = "/tmp/test-brain-dump";
  const mockStateManager = stateManager as jest.Mocked<typeof stateManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe("scanDirectory", () => {
    it("should find markdown files in directory", async () => {
      // Create test files
      fs.writeFileSync(path.join(testDir, "note1.md"), "# Note 1");
      fs.writeFileSync(path.join(testDir, "note2.md"), "# Note 2");
      fs.writeFileSync(path.join(testDir, "readme.txt"), "Not markdown");
      fs.writeFileSync(path.join(testDir, "note3.markdown"), "# Note 3"); // Different extension

      const files = await fileIngester.scanDirectory(testDir);

      expect(files).toHaveLength(2);
      expect(files).toContain(path.join(testDir, "note1.md"));
      expect(files).toContain(path.join(testDir, "note2.md"));
      expect(files).not.toContain(path.join(testDir, "readme.txt"));
      expect(files).not.toContain(path.join(testDir, "note3.markdown"));
    });

    it("should handle empty directory", async () => {
      const files = await fileIngester.scanDirectory(testDir);
      expect(files).toHaveLength(0);
    });

    it("should throw error for non-existent directory", async () => {
      await expect(fileIngester.scanDirectory("/nonexistent/path")).rejects.toThrow(
        "Directory does not exist"
      );
    });

    it("should throw error if path is not a directory", async () => {
      const filePath = path.join(testDir, "not-a-dir.txt");
      fs.writeFileSync(filePath, "content");

      await expect(fileIngester.scanDirectory(filePath)).rejects.toThrow(
        "Path is not a directory"
      );
    });

    it("should expand tilde in path", async () => {
      const homePath = require("os").homedir();
      const relativePath = path.relative(homePath, testDir);
      const tildePath = `~/${relativePath}`;

      fs.writeFileSync(path.join(testDir, "test.md"), "# Test");

      const files = await fileIngester.scanDirectory(tildePath);
      expect(files).toHaveLength(1);
    });
  });

  describe("readFiles", () => {
    it("should read only modified files", async () => {
      const file1 = path.join(testDir, "modified.md");
      const file2 = path.join(testDir, "unmodified.md");

      fs.writeFileSync(file1, "# Modified content");
      fs.writeFileSync(file2, "# Unmodified content");

      // Mock state manager responses
      mockStateManager.isFileModified.mockImplementation((filePath) => {
        return filePath === file1; // Only file1 is modified
      });

      const fileContents = await fileIngester.readFiles([file1, file2]);

      expect(fileContents).toHaveLength(1);
      expect(fileContents[0].filePath).toBe(file1);
      expect(fileContents[0].content).toBe("# Modified content");
      expect(fileContents[0].isModified).toBe(true);

      expect(mockStateManager.isFileModified).toHaveBeenCalledTimes(2);
      expect(mockStateManager.isFileModified).toHaveBeenCalledWith(file1);
      expect(mockStateManager.isFileModified).toHaveBeenCalledWith(file2);
    });

    it("should handle file read errors gracefully", async () => {
      const existingFile = path.join(testDir, "existing.md");
      const missingFile = path.join(testDir, "missing.md");

      fs.writeFileSync(existingFile, "# Content");
      // Don't create missingFile

      mockStateManager.isFileModified.mockReturnValue(true);

      const fileContents = await fileIngester.readFiles([existingFile, missingFile]);

      expect(fileContents).toHaveLength(1);
      expect(fileContents[0].filePath).toBe(existingFile);
    });

    it("should handle empty file list", async () => {
      const fileContents = await fileIngester.readFiles([]);
      expect(fileContents).toHaveLength(0);
    });
  });

  describe("chunkContent", () => {
    it("should not chunk small files", () => {
      const fileContent = {
        filePath: "/test/small.md",
        content: "# Small file\n\nSome content",
        modifiedTime: Date.now(),
        isModified: true,
      };

      const chunks = fileIngester.chunkContent(fileContent);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        filePath: fileContent.filePath,
        content: fileContent.content,
        chunkIndex: 0,
        totalChunks: 1,
      });
    });

    it("should chunk large files", () => {
      const longContent = "# Large file\n\n" + "Long line of content.\n".repeat(1000);
      const fileContent = {
        filePath: "/test/large.md",
        content: longContent,
        modifiedTime: Date.now(),
        isModified: true,
      };

      const chunks = fileIngester.chunkContent(fileContent);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].chunkIndex).toBe(0);
      expect(chunks[0].totalChunks).toBe(chunks.length);
      expect(chunks[chunks.length - 1].chunkIndex).toBe(chunks.length - 1);

      // Verify all chunks have the same file path and total chunks
      chunks.forEach((chunk, index) => {
        expect(chunk.filePath).toBe(fileContent.filePath);
        expect(chunk.chunkIndex).toBe(index);
        expect(chunk.totalChunks).toBe(chunks.length);
      });

      // Verify content is preserved when rejoined
      const rejoined = chunks.map(c => c.content).join("\n");
      expect(rejoined.length).toBeGreaterThanOrEqual(longContent.length - chunks.length + 1); // Account for join separators
    });

    it("should handle files with long lines", () => {
      const veryLongLine = "A".repeat(10000);
      const fileContent = {
        filePath: "/test/longline.md",
        content: `# Title\n${veryLongLine}\n# End`,
        modifiedTime: Date.now(),
        isModified: true,
      };

      const chunks = fileIngester.chunkContent(fileContent);

      expect(chunks.length).toBeGreaterThan(1);
      
      // Verify each chunk is under the limit (or contains a single long line)
      chunks.forEach(chunk => {
        expect(chunk.content.length).toBeLessThanOrEqual(10000);
      });
    });
  });

  describe("ingestFiles", () => {
    it("should perform complete ingestion workflow", async () => {
      // Create test files
      fs.writeFileSync(path.join(testDir, "note1.md"), "# Note 1\n- [ ] Task 1");
      fs.writeFileSync(path.join(testDir, "note2.md"), "# Note 2\n- [ ] Task 2");

      mockStateManager.isFileModified.mockReturnValue(true);

      const chunks = await fileIngester.ingestFiles(testDir);

      expect(chunks).toHaveLength(2);
      expect(chunks[0].filePath).toBe(path.join(testDir, "note1.md"));
      expect(chunks[1].filePath).toBe(path.join(testDir, "note2.md"));

      // Verify state manager was called to update file times
      expect(mockStateManager.updateFileModifiedTime).toHaveBeenCalledTimes(2);
      expect(mockStateManager.updateFileModifiedTime).toHaveBeenCalledWith(path.join(testDir, "note1.md"));
      expect(mockStateManager.updateFileModifiedTime).toHaveBeenCalledWith(path.join(testDir, "note2.md"));
    });

    it("should return empty array when no markdown files exist", async () => {
      fs.writeFileSync(path.join(testDir, "readme.txt"), "Not markdown");

      const chunks = await fileIngester.ingestFiles(testDir);

      expect(chunks).toHaveLength(0);
    });

    it("should return empty array when no files are modified", async () => {
      fs.writeFileSync(path.join(testDir, "note.md"), "# Note");

      mockStateManager.isFileModified.mockReturnValue(false);

      const chunks = await fileIngester.ingestFiles(testDir);

      expect(chunks).toHaveLength(0);
      expect(mockStateManager.updateFileModifiedTime).not.toHaveBeenCalled();
    });

    it("should handle directory access errors", async () => {
      await expect(fileIngester.ingestFiles("/nonexistent")).rejects.toThrow();
    });
  });

  describe("healthCheck", () => {
    it("should return healthy for accessible directory", async () => {
      const result = await fileIngester.healthCheck(testDir);

      expect(result.healthy).toBe(true);
      expect(result.message).toContain("Directory accessible");
    });

    it("should return unhealthy for non-existent directory", async () => {
      const result = await fileIngester.healthCheck("/nonexistent/path");

      expect(result.healthy).toBe(false);
      expect(result.message).toContain("Directory does not exist");
    });

    it("should return unhealthy for file instead of directory", async () => {
      const filePath = path.join(testDir, "file.txt");
      fs.writeFileSync(filePath, "content");

      const result = await fileIngester.healthCheck(filePath);

      expect(result.healthy).toBe(false);
      expect(result.message).toContain("Path is not a directory");
    });

    it("should handle tilde expansion in health check", async () => {
      const homePath = require("os").homedir();
      const relativePath = path.relative(homePath, testDir);
      const tildePath = `~/${relativePath}`;

      const result = await fileIngester.healthCheck(tildePath);

      expect(result.healthy).toBe(true);
    });

    it("should return unhealthy for permission errors", async () => {
      // Create a directory with restricted permissions (if possible)
      const restrictedDir = path.join(testDir, "restricted");
      fs.mkdirSync(restrictedDir);
      
      try {
        fs.chmodSync(restrictedDir, 0o000); // No permissions

        const result = await fileIngester.healthCheck(restrictedDir);

        expect(result.healthy).toBe(false);
        expect(result.message).toContain("Directory access error");
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(restrictedDir, 0o755);
      }
    });
  });
});