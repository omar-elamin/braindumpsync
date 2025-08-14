import { stateManager } from "../src/state";
import { ExtractedTask } from "../src/state";
import * as fs from "fs";
import * as path from "path";

// Raycast API is mocked globally via __mocks__/@raycast/api.js

describe("StateManager", () => {
  const testSupportPath = "/tmp/test-raycast-support";
  const testStateFile = path.join(testSupportPath, "state.json");

  beforeEach(() => {
    // Clean up test files
    if (fs.existsSync(testStateFile)) {
      fs.unlinkSync(testStateFile);
    }
    if (fs.existsSync(testSupportPath)) {
      fs.rmSync(testSupportPath, { recursive: true });
    }
    
    // Reset state manager
    stateManager.reset();
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(testSupportPath)) {
      fs.rmSync(testSupportPath, { recursive: true });
    }
  });

  describe("generateTaskHash", () => {
    it("should generate consistent hash for same input", () => {
      const task: ExtractedTask = {
        title: "Buy milk",
        due: "2025-08-16",
        tags: ["shopping"],
      };

      const hash1 = stateManager.generateTaskHash(task, "/test/file.md", 0);
      const hash2 = stateManager.generateTaskHash(task, "/test/file.md", 0);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(16);
    });

    it("should generate different hashes for different tasks", () => {
      const task1: ExtractedTask = {
        title: "Buy milk",
        due: null,
        tags: null,
      };
      
      const task2: ExtractedTask = {
        title: "Buy bread", 
        due: null,
        tags: null,
      };

      const hash1 = stateManager.generateTaskHash(task1, "/test/file.md", 0);
      const hash2 = stateManager.generateTaskHash(task2, "/test/file.md", 0);
      
      expect(hash1).not.toBe(hash2);
    });

    it("should generate different hashes for same task in different locations", () => {
      const task: ExtractedTask = {
        title: "Buy milk",
        due: null,
        tags: null,
      };

      const hash1 = stateManager.generateTaskHash(task, "/test/file1.md", 0);
      const hash2 = stateManager.generateTaskHash(task, "/test/file2.md", 0);
      const hash3 = stateManager.generateTaskHash(task, "/test/file1.md", 1);
      
      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash2).not.toBe(hash3);
    });

    it("should be case insensitive for task title", () => {
      const task1: ExtractedTask = {
        title: "Buy Milk",
        due: null,
        tags: null,
      };
      
      const task2: ExtractedTask = {
        title: "buy milk",
        due: null,
        tags: null,
      };

      const hash1 = stateManager.generateTaskHash(task1, "/test/file.md", 0);
      const hash2 = stateManager.generateTaskHash(task2, "/test/file.md", 0);
      
      expect(hash1).toBe(hash2);
    });

    it("should handle whitespace in task title", () => {
      const task1: ExtractedTask = {
        title: " Buy milk ",
        due: null,
        tags: null,
      };
      
      const task2: ExtractedTask = {
        title: "Buy milk",
        due: null,
        tags: null,
      };

      const hash1 = stateManager.generateTaskHash(task1, "/test/file.md", 0);
      const hash2 = stateManager.generateTaskHash(task2, "/test/file.md", 0);
      
      expect(hash1).toBe(hash2);
    });
  });

  describe("task processing state", () => {
    it("should track processed tasks", () => {
      const hash = "test-hash-123";
      
      expect(stateManager.isTaskProcessed(hash)).toBe(false);
      
      stateManager.markTaskProcessed(hash);
      
      expect(stateManager.isTaskProcessed(hash)).toBe(true);
    });

    it("should persist processed tasks to file", () => {
      const hash = "test-hash-123";
      
      stateManager.markTaskProcessed(hash);
      stateManager.save();
      
      expect(fs.existsSync(testStateFile)).toBe(true);
      
      const savedState = JSON.parse(fs.readFileSync(testStateFile, "utf8"));
      expect(savedState.processedTasks).toContain(hash);
    });

    it("should load processed tasks from file", () => {
      const hash = "test-hash-123";
      
      // Create state file manually
      fs.mkdirSync(testSupportPath, { recursive: true });
      const stateData = {
        lastRun: null,
        processedTasks: [hash],
        lastModifiedTimes: {},
      };
      fs.writeFileSync(testStateFile, JSON.stringify(stateData));
      
      // Reset and verify it loads the state
      stateManager.reset();
      expect(stateManager.isTaskProcessed(hash)).toBe(true);
    });
  });

  describe("file modification tracking", () => {
    const testFile = path.join(testSupportPath, "test.md");

    beforeEach(() => {
      // Create test file
      fs.mkdirSync(testSupportPath, { recursive: true });
      fs.writeFileSync(testFile, "test content");
    });

    it("should detect new files as modified", () => {
      expect(stateManager.isFileModified(testFile)).toBe(true);
    });

    it("should track file modification times", () => {
      stateManager.updateFileModifiedTime(testFile);
      
      // File should not be considered modified immediately after updating
      expect(stateManager.isFileModified(testFile)).toBe(false);
    });

    it("should detect file changes", async () => {
      stateManager.updateFileModifiedTime(testFile);
      expect(stateManager.isFileModified(testFile)).toBe(false);
      
      // Wait a bit and modify file
      await new Promise(resolve => setTimeout(resolve, 10));
      fs.writeFileSync(testFile, "updated content");
      
      expect(stateManager.isFileModified(testFile)).toBe(true);
    });

    it("should handle missing files gracefully", () => {
      const missingFile = "/nonexistent/file.md";
      
      expect(stateManager.isFileModified(missingFile)).toBe(true);
      expect(() => stateManager.updateFileModifiedTime(missingFile)).not.toThrow();
    });
  });

  describe("last run tracking", () => {
    it("should start with no last run", () => {
      expect(stateManager.getLastRun()).toBeNull();
    });

    it("should update last run time", () => {
      const beforeUpdate = new Date().toISOString();
      
      stateManager.updateLastRun();
      
      const lastRun = stateManager.getLastRun();
      expect(lastRun).not.toBeNull();
      expect(new Date(lastRun!).getTime()).toBeGreaterThanOrEqual(new Date(beforeUpdate).getTime());
    });

    it("should persist last run time", () => {
      stateManager.updateLastRun();
      const lastRun = stateManager.getLastRun();
      
      stateManager.reset();
      stateManager.updateLastRun();
      
      expect(fs.existsSync(testStateFile)).toBe(true);
      
      const savedState = JSON.parse(fs.readFileSync(testStateFile, "utf8"));
      expect(savedState.lastRun).not.toBeNull();
    });
  });

  describe("cleanup", () => {
    it("should remove old processed tasks when exceeding limit", () => {
      // Add many tasks
      const hashes = Array.from({ length: 15000 }, (_, i) => `hash-${i}`);
      
      hashes.forEach(hash => stateManager.markTaskProcessed(hash));
      
      expect(stateManager.getProcessedTaskCount()).toBe(15000);
      
      stateManager.cleanup(10000);
      
      // Should keep 80% of max (8000 tasks)
      expect(stateManager.getProcessedTaskCount()).toBe(8000);
    });

    it("should remove old file modification times", () => {
      const testFile1 = "/test/file1.md";
      const testFile2 = "/test/file2.md";
      
      // Mock old modification time (40 days ago)
      const oldTime = Date.now() - (40 * 24 * 60 * 60 * 1000);
      
      // Manually set old times by creating state
      fs.mkdirSync(testSupportPath, { recursive: true });
      const stateData = {
        lastRun: null,
        processedTasks: [],
        lastModifiedTimes: {
          [testFile1]: oldTime,
          [testFile2]: Date.now(), // Recent time
        },
      };
      fs.writeFileSync(testStateFile, JSON.stringify(stateData));
      
      stateManager.reset(); // Reload state
      stateManager.cleanup();
      
      // Verify cleanup removed old entries
      const savedState = JSON.parse(fs.readFileSync(testStateFile, "utf8"));
      expect(savedState.lastModifiedTimes.hasOwnProperty(testFile1)).toBe(false);
      expect(savedState.lastModifiedTimes.hasOwnProperty(testFile2)).toBe(true);
    });
  });

  describe("state persistence", () => {
    it("should create support directory if it doesn't exist", () => {
      const hash = "test-hash";
      
      stateManager.markTaskProcessed(hash);
      stateManager.save();
      
      expect(fs.existsSync(testSupportPath)).toBe(true);
      expect(fs.existsSync(testStateFile)).toBe(true);
    });

    it("should handle corrupted state files gracefully", () => {
      // Create corrupted state file
      fs.mkdirSync(testSupportPath, { recursive: true });
      fs.writeFileSync(testStateFile, "invalid json {");
      
      // Should load default state without crashing
      stateManager.reset();
      
      expect(stateManager.getLastRun()).toBeNull();
      expect(stateManager.getProcessedTaskCount()).toBe(0);
    });

    it("should handle missing state file gracefully", () => {
      stateManager.reset();
      
      expect(stateManager.getLastRun()).toBeNull();
      expect(stateManager.getProcessedTaskCount()).toBe(0);
    });
  });
});