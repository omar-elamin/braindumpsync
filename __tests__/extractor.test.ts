import { taskExtractor } from "../src/extractor";
import { FileChunk } from "../src/ingest";

// Mock fetch globally
global.fetch = jest.fn();

describe("TaskExtractor", () => {
  const mockApiKey = "test-api-key";
  const mockModel = "gpt-4";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("extractTasks", () => {
    it("should extract tasks from markdown with various formats", async () => {
      const chunk: FileChunk = {
        filePath: "/test/file.md",
        content: `# Meeting Notes

- [ ] Buy milk due:16/08
- [ ] Send invoice to client
- [x] Already completed task
TODO: call John tomorrow
* follow up with Sarah about the proposal due:2025-08-20
Regular text that should not be extracted
- [ ] Review PR #123`,
        chunkIndex: 0,
        totalChunks: 1,
      };

      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                tasks: [
                  { title: "Buy milk", due: "2025-08-16", tags: null },
                  { title: "Send invoice to client", due: null, tags: null },
                  { title: "Call John tomorrow", due: null, tags: null },
                  { title: "Follow up with Sarah about the proposal", due: "2025-08-20", tags: null },
                  { title: "Review PR #123", due: null, tags: null },
                ],
              }),
            },
          },
        ],
      };

      (fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await taskExtractor.extractTasks(chunk, mockApiKey, mockModel);

      expect(result.tasks).toHaveLength(5);
      expect(result.tasks[0]).toEqual({
        title: "Buy milk",
        due: "2025-08-16",
        tags: null,
      });
      expect(result.tasks[1]).toEqual({
        title: "Send invoice to client", 
        due: null,
        tags: null,
      });
      expect(result.chunk).toBe(chunk);
    });

    it("should handle date normalisation correctly", async () => {
      const chunk: FileChunk = {
        filePath: "/test/file.md",
        content: "- [ ] Task 1 due:16/08\n- [ ] Task 2 due:5/12\n- [ ] Task 3 due:2025-09-15",
        chunkIndex: 0,
        totalChunks: 1,
      };

      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                tasks: [
                  { title: "Task 1", due: "16/08", tags: null },
                  { title: "Task 2", due: "5/12", tags: null },
                  { title: "Task 3", due: "2025-09-15", tags: null },
                ],
              }),
            },
          },
        ],
      };

      (fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await taskExtractor.extractTasks(chunk, mockApiKey, mockModel);
      
      expect(result.tasks[0].due).toBe("2025-08-16");
      expect(result.tasks[1].due).toBe("2025-12-05"); 
      expect(result.tasks[2].due).toBe("2025-09-15");
    });

    it("should handle API errors gracefully", async () => {
      const chunk: FileChunk = {
        filePath: "/test/file.md",
        content: "- [ ] Test task",
        chunkIndex: 0,
        totalChunks: 1,
      };

      (fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error": {"message": "Invalid API key"}}'),
      });

      const result = await taskExtractor.extractTasks(chunk, mockApiKey, mockModel);
      
      expect(result.tasks).toHaveLength(0);
      expect(result.chunk).toBe(chunk);
    });

    it("should retry on rate limit with exponential backoff", async () => {
      const chunk: FileChunk = {
        filePath: "/test/file.md", 
        content: "- [ ] Test task",
        chunkIndex: 0,
        totalChunks: 1,
      };

      // First call fails with 429, second succeeds
      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve('{"error": {"message": "Rate limit exceeded"}}'),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: '{"tasks": [{"title": "Test task", "due": null, "tags": null}]}' } }],
          }),
        });

      const result = await taskExtractor.extractTasks(chunk, mockApiKey, mockModel);
      
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.tasks).toHaveLength(1);
    });

    it("should handle invalid JSON response with retry", async () => {
      const chunk: FileChunk = {
        filePath: "/test/file.md",
        content: "- [ ] Test task", 
        chunkIndex: 0,
        totalChunks: 1,
      };

      // First response is invalid JSON, second is valid
      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: "Invalid JSON response here" } }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: '{"tasks": [{"title": "Test task", "due": null, "tags": null}]}' } }],
          }),
        });

      const result = await taskExtractor.extractTasks(chunk, mockApiKey, mockModel);
      
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.tasks).toHaveLength(1);
    });
  });

  describe("healthCheck", () => {
    it("should return healthy status when API is working", async () => {
      (fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '{"test": true}' } }],
        }),
      });

      const result = await taskExtractor.healthCheck(mockApiKey, mockModel);
      
      expect(result.healthy).toBe(true);
      expect(result.message).toBe("OpenAI API connection successful");
    });

    it("should return unhealthy status when API fails", async () => {
      (fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error": {"message": "Invalid API key"}}'),
      });

      const result = await taskExtractor.healthCheck(mockApiKey, mockModel);
      
      expect(result.healthy).toBe(false);
      expect(result.message).toContain("Invalid API key");
    });
  });

  describe("extractTasksFromChunks", () => {
    it("should process multiple chunks with concurrency control", async () => {
      const chunks: FileChunk[] = [
        { filePath: "/test/file1.md", content: "- [ ] Task 1", chunkIndex: 0, totalChunks: 1 },
        { filePath: "/test/file2.md", content: "- [ ] Task 2", chunkIndex: 0, totalChunks: 1 },
        { filePath: "/test/file3.md", content: "- [ ] Task 3", chunkIndex: 0, totalChunks: 1 },
      ];

      (fetch as jest.Mock).mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: '{"tasks": [{"title": "Test task", "due": null, "tags": null}]}' } }],
          }),
        })
      );

      const results = await taskExtractor.extractTasksFromChunks(chunks, mockApiKey, mockModel, 2);
      
      expect(results).toHaveLength(3);
      expect(results.every(r => r.tasks.length === 1)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
    });
  });
});