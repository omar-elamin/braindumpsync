import { notionClient } from "../src/notion";
import { TaskWithMeta } from "../src/state";

// Mock fetch globally
global.fetch = jest.fn();

describe("NotionClient", () => {
  const mockToken = "test-notion-token";
  const mockDatabaseId = "test-database-id";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createTask", () => {
    it("should create a Notion page with correct properties", async () => {
      const task: TaskWithMeta = {
        title: "Buy milk",
        due: "2025-08-16",
        tags: ["shopping", "urgent"],
        hash: "test-hash-123",
        filePath: "/Users/test/BrainDump/2025-08-15.md",
        lineIndex: 5,
        extractedAt: "2025-08-15T10:00:00Z",
      };

      // Mock task exists check (returns false - doesn't exist)
      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        })
        // Mock page creation
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            id: "page-id-123",
            url: "https://notion.so/page-id-123",
          }),
        });

      const result = await notionClient.createTask(mockToken, mockDatabaseId, task);

      expect(result.success).toBe(true);
      expect(result.pageId).toBe("page-id-123");
      expect(result.pageUrl).toBe("https://notion.so/page-id-123");

      // Verify the correct API calls were made
      expect(fetch).toHaveBeenCalledTimes(2);

      // Check the page creation call
      const createCall = (fetch as jest.Mock).mock.calls[1];
      expect(createCall[0]).toBe("https://api.notion.com/v1/pages");
      expect(createCall[1].method).toBe("POST");
      
      const createBody = JSON.parse(createCall[1].body);
      expect(createBody.parent.database_id).toBe(mockDatabaseId);
      expect(createBody.properties.Name.title[0].text.content).toBe("Buy milk");
      expect(createBody.properties.Status.select.name).toBe("Inbox");
      expect(createBody.properties["Due Date"].date.start).toBe("2025-08-16");
      expect(createBody.properties.Tags.multi_select).toHaveLength(2);
      expect(createBody.properties.Tags.multi_select[0].name).toBe("shopping");
      expect(createBody.properties.Tags.multi_select[1].name).toBe("urgent");
      expect(createBody.properties["Task ID"].rich_text[0].text.content).toBe("test-hash-123");
      expect(createBody.properties.Source.rich_text[0].text.content).toBe("2025-08-15.md:6");
    });

    it("should handle tasks without due date and tags", async () => {
      const task: TaskWithMeta = {
        title: "Simple task",
        due: null,
        tags: null,
        hash: "simple-hash",
        filePath: "/test/file.md",
        lineIndex: 0,
        extractedAt: "2025-08-15T10:00:00Z",
      };

      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            id: "simple-page-id",
            url: "https://notion.so/simple-page-id",
          }),
        });

      const result = await notionClient.createTask(mockToken, mockDatabaseId, task);

      expect(result.success).toBe(true);

      const createCall = (fetch as jest.Mock).mock.calls[1];
      const createBody = JSON.parse(createCall[1].body);
      
      expect(createBody.properties).not.toHaveProperty("Due Date");
      expect(createBody.properties).not.toHaveProperty("Tags");
      expect(createBody.properties.Name.title[0].text.content).toBe("Simple task");
    });

    it("should skip creating task if it already exists", async () => {
      const task: TaskWithMeta = {
        title: "Existing task",
        due: null,
        tags: null,
        hash: "existing-hash",
        filePath: "/test/file.md",
        lineIndex: 0,
        extractedAt: "2025-08-15T10:00:00Z",
      };

      // Mock task exists check (returns true - already exists)
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ 
          results: [{ id: "existing-page-id" }] 
        }),
      });

      const result = await notionClient.createTask(mockToken, mockDatabaseId, task);

      expect(result.success).toBe(true);
      expect(result.pageId).toBe("existing");
      expect(result.pageUrl).toBe("existing");

      // Should only make one call (the existence check)
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("should handle Notion API errors", async () => {
      const task: TaskWithMeta = {
        title: "Error task",
        due: null,
        tags: null,
        hash: "error-hash",
        filePath: "/test/file.md",
        lineIndex: 0,
        extractedAt: "2025-08-15T10:00:00Z",
      };

      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve('{"object":"error","status":400,"message":"Invalid properties"}'),
        });

      const result = await notionClient.createTask(mockToken, mockDatabaseId, task);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid properties");
    });

    it("should retry on rate limits", async () => {
      const task: TaskWithMeta = {
        title: "Rate limited task",
        due: null,
        tags: null,
        hash: "rate-hash",
        filePath: "/test/file.md",
        lineIndex: 0,
        extractedAt: "2025-08-15T10:00:00Z",
      };

      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        })
        // First create attempt fails with 429
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve('{"object":"error","status":429,"message":"Rate limited"}'),
        })
        // Second attempt succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            id: "retry-page-id",
            url: "https://notion.so/retry-page-id",
          }),
        });

      const result = await notionClient.createTask(mockToken, mockDatabaseId, task);

      expect(result.success).toBe(true);
      expect(result.pageId).toBe("retry-page-id");
      
      // Should make 3 calls total (exists check + 2 create attempts)
      expect(fetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("syncTasks", () => {
    it("should sync multiple tasks with concurrency control", async () => {
      const tasks: TaskWithMeta[] = [
        {
          title: "Task 1",
          due: null,
          tags: null,
          hash: "hash-1",
          filePath: "/test/file1.md",
          lineIndex: 0,
          extractedAt: "2025-08-15T10:00:00Z",
        },
        {
          title: "Task 2", 
          due: null,
          tags: null,
          hash: "hash-2",
          filePath: "/test/file2.md",
          lineIndex: 0,
          extractedAt: "2025-08-15T10:00:00Z",
        },
      ];

      // Mock all tasks as non-existing and create successfully
      (fetch as jest.Mock).mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            results: [], // For existence checks
            id: "page-id",
            url: "https://notion.so/page-id",
          }),
        })
      );

      const results = await notionClient.syncTasks(mockToken, mockDatabaseId, tasks, 2);

      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);
      
      // Each task should make 2 calls (exists check + create)
      expect(fetch).toHaveBeenCalledTimes(4);
    });

    it("should handle mixed success and failure results", async () => {
      const tasks: TaskWithMeta[] = [
        {
          title: "Success task",
          due: null,
          tags: null,
          hash: "success-hash",
          filePath: "/test/file1.md",
          lineIndex: 0,
          extractedAt: "2025-08-15T10:00:00Z",
        },
        {
          title: "Failure task",
          due: null,
          tags: null,
          hash: "failure-hash",
          filePath: "/test/file2.md",
          lineIndex: 0,
          extractedAt: "2025-08-15T10:00:00Z",
        },
      ];

      (fetch as jest.Mock)
        // Success task - exists check returns false, create succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            id: "success-page-id",
            url: "https://notion.so/success-page-id",
          }),
        })
        // Failure task - exists check returns false, create fails
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve('{"object":"error","message":"Bad request"}'),
        });

      const results = await notionClient.syncTasks(mockToken, mockDatabaseId, tasks);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toContain("Bad request");
    });
  });

  describe("healthCheck", () => {
    it("should return healthy when database is accessible with required properties", async () => {
      const mockDatabaseResponse = {
        properties: {
          "Name": { type: "title" },
          "Status": { type: "select" },
          "Due Date": { type: "date" },
          "Tags": { type: "multi_select" },
          "Task ID": { type: "rich_text" },
          "Source": { type: "rich_text" },
        },
      };

      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockDatabaseResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        });

      const result = await notionClient.healthCheck(mockToken, mockDatabaseId);

      expect(result.healthy).toBe(true);
      expect(result.message).toBe("Notion database accessible with required properties");
    });

    it("should return unhealthy when required properties are missing", async () => {
      const mockDatabaseResponse = {
        properties: {
          "Name": { type: "title" },
          "Status": { type: "select" },
          // Missing required properties
        },
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockDatabaseResponse),
      });

      const result = await notionClient.healthCheck(mockToken, mockDatabaseId);

      expect(result.healthy).toBe(false);
      expect(result.message).toContain("Missing required database properties");
      expect(result.message).toContain("Due Date");
      expect(result.message).toContain("Tags");
      expect(result.message).toContain("Task ID");
      expect(result.message).toContain("Source");
    });

    it("should return unhealthy when database is inaccessible", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"object":"error","message":"Database not found"}'),
      });

      const result = await notionClient.healthCheck(mockToken, mockDatabaseId);

      expect(result.healthy).toBe(false);
      expect(result.message).toContain("Database not found");
    });

    it("should return unhealthy when authentication fails", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"object":"error","message":"Unauthorized"}'),
      });

      const result = await notionClient.healthCheck(mockToken, mockDatabaseId);

      expect(result.healthy).toBe(false);
      expect(result.message).toContain("Unauthorized");
    });
  });

  describe("taskExists", () => {
    it("should return true when task exists", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          results: [{ id: "existing-page-id" }],
        }),
      });

      const exists = await notionClient.taskExists(mockToken, mockDatabaseId, "test-hash");

      expect(exists).toBe(true);
      
      const call = (fetch as jest.Mock).mock.calls[0];
      expect(call[0]).toBe(`https://api.notion.com/v1/databases/${mockDatabaseId}/query`);
      expect(call[1].method).toBe("POST");
      
      const body = JSON.parse(call[1].body);
      expect(body.filter.property).toBe("Task ID");
      expect(body.filter.rich_text.equals).toBe("test-hash");
    });

    it("should return false when task does not exist", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          results: [],
        }),
      });

      const exists = await notionClient.taskExists(mockToken, mockDatabaseId, "nonexistent-hash");

      expect(exists).toBe(false);
    });

    it("should return false on API errors", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal server error"),
      });

      const exists = await notionClient.taskExists(mockToken, mockDatabaseId, "error-hash");

      expect(exists).toBe(false);
    });
  });
});