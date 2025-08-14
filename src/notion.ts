import { TaskWithMeta } from "./state";
import { logger } from "./log";
import * as path from "path";

// Utility function to safely extract error messages
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

interface NotionProperty {
  [key: string]: any;
}

interface NotionPage {
  parent: { database_id: string };
  properties: Record<string, NotionProperty>;
}

interface NotionResponse {
  id: string;
  url: string;
}

interface NotionError {
  object: "error";
  status: number;
  code: string;
  message: string;
}

export interface NotionSyncResult {
  success: boolean;
  pageId?: string;
  pageUrl?: string;
  error?: string;
}

class NotionClient {
  private baseUrl = "https://api.notion.com/v1";
  private version = "2022-06-28";

  /**
   * Create a rich text property
   */
  private createRichText(content: string): NotionProperty {
    return {
      rich_text: [
        {
          text: {
            content: content.substring(0, 2000), // Notion limit
          },
        },
      ],
    };
  }

  /**
   * Create a title property
   */
  private createTitle(content: string): NotionProperty {
    return {
      title: [
        {
          text: {
            content: content.substring(0, 2000), // Notion limit
          },
        },
      ],
    };
  }

  /**
   * Create a date property
   */
  private createDate(dateString: string): NotionProperty {
    return {
      date: {
        start: dateString,
      },
    };
  }

  /**
   * Create a select property
   */
  private createSelect(value: string): NotionProperty {
    return {
      select: {
        name: value,
      },
    };
  }

  /**
   * Create a status property
   */
  private createStatus(value: string): NotionProperty {
    return {
      status: {
        name: value,
      },
    };
  }

  /**
   * Create a multi-select property
   */
  private createMultiSelect(values: string[]): NotionProperty {
    return {
      multi_select: values.map((value) => ({
        name: value,
      })),
    };
  }

  /**
   * Build Notion page properties for a task
   */
  private buildPageProperties(task: TaskWithMeta): Record<string, NotionProperty> {
    const properties: Record<string, NotionProperty> = {
      Name: this.createTitle(task.title),
      Status: this.createStatus("Not started"),
      "Task ID": this.createRichText(task.hash),
      "Captured From": this.createRichText("Brain Dump"),
    };

    if (task.due) {
      properties["Due Date"] = this.createDate(task.due);
    }

    if (task.tags && task.tags.length > 0) {
      properties.Tags = this.createMultiSelect(task.tags);
    }

    return properties;
  }

  /**
   * Make API call to Notion
   */
  private async callNotion(
    token: string,
    endpoint: string,
    method: string = "GET",
    body?: any,
    attempt = 1
  ): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": this.version,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage = `HTTP ${response.status}`;

      try {
        const errorJson = JSON.parse(errorBody) as NotionError;
        errorMessage = errorJson.message || errorMessage;
      } catch {
        errorMessage = errorBody || errorMessage;
      }

      // Handle rate limiting with exponential backoff
      if (response.status === 429 && attempt <= 3) {
        const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        logger.warn(`Notion rate limited, retrying in ${delayMs}ms`, { attempt });
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return this.callNotion(token, endpoint, method, body, attempt + 1);
      }

      // Handle server errors with retry
      if (response.status >= 500 && attempt <= 2) {
        const delayMs = attempt * 2000; // 2s, 4s
        logger.warn(`Notion server error, retrying in ${delayMs}ms`, { attempt, status: response.status });
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return this.callNotion(token, endpoint, method, body, attempt + 1);
      }

      throw new Error(`Notion API error: ${errorMessage}`);
    }

    return response.json();
  }

  /**
   * Check if a task already exists in Notion by Task ID
   */
  async taskExists(token: string, databaseId: string, taskHash: string): Promise<boolean> {
    try {
      const searchBody = {
        filter: {
          property: "Task ID",
          rich_text: {
            equals: taskHash,
          },
        },
      };

      const response = await this.callNotion(
        token,
        `/databases/${databaseId}/query`,
        "POST",
        searchBody
      );

      return response.results && response.results.length > 0;
    } catch (error) {
      logger.warn("Failed to check if task exists, assuming it doesn't", {
        taskHash,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Create a new page in Notion database
   */
  async createTask(token: string, databaseId: string, task: TaskWithMeta): Promise<NotionSyncResult> {
    try {
      logger.debug("Creating Notion page", {
        taskTitle: task.title,
        taskHash: task.hash,
        dueDate: task.due,
      });

      // Check if task already exists
      const exists = await this.taskExists(token, databaseId, task.hash);
      if (exists) {
        logger.debug("Task already exists in Notion, skipping", { taskHash: task.hash });
        return {
          success: true,
          pageId: "existing",
          pageUrl: "existing",
        };
      }

      const pageData: NotionPage = {
        parent: {
          database_id: databaseId,
        },
        properties: this.buildPageProperties(task),
      };

      logger.debug("Sending task to Notion", {
        taskTitle: task.title,
        pageProperties: Object.keys(pageData.properties),
        payloadSize: JSON.stringify(pageData).length
      });

      const response = await this.callNotion(token, "/pages", "POST", pageData) as NotionResponse;

      logger.info("Notion page created successfully", {
        taskTitle: task.title,
        pageId: response.id,
        pageUrl: response.url,
      });

      return {
        success: true,
        pageId: response.id,
        pageUrl: response.url,
      };

    } catch (error) {
      logger.error("Failed to create Notion page", {
        taskTitle: task.title,
        taskHash: task.hash,
        error: getErrorMessage(error),
      });

      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Sync multiple tasks to Notion
   */
  async syncTasks(
    token: string,
    databaseId: string,
    tasks: TaskWithMeta[],
    maxConcurrency = 3
  ): Promise<NotionSyncResult[]> {
    logger.info("Starting Notion sync", {
      taskCount: tasks.length,
      maxConcurrency,
    });

    const results: NotionSyncResult[] = [];

    // Process tasks in batches to avoid overwhelming Notion API
    for (let i = 0; i < tasks.length; i += maxConcurrency) {
      const batch = tasks.slice(i, i + maxConcurrency);
      
      const batchPromises = batch.map(task => 
        this.createTask(token, databaseId, task)
      );
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Small delay between batches to be respectful to the API
      if (i + maxConcurrency < tasks.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    logger.info("Notion sync completed", {
      total: tasks.length,
      successful,
      failed,
    });

    return results;
  }

  /**
   * Health check - verify database access and required properties
   */
  async healthCheck(token: string, databaseId: string): Promise<{ healthy: boolean; message: string }> {
    try {
      // Try to retrieve database info
      const database = await this.callNotion(token, `/databases/${databaseId}`);
      
      const requiredProperties = ["Name", "Status", "Due Date", "Tags", "Task ID", "Captured From"];
      const existingProperties = Object.keys(database.properties || {});
      
      const missingProperties = requiredProperties.filter(
        prop => !existingProperties.includes(prop)
      );

      if (missingProperties.length > 0) {
        return {
          healthy: false,
          message: `Missing required database properties: ${missingProperties.join(", ")}. Please ensure your Notion database has these columns: Name (title), Status (select), Due Date (date), Tags (multi-select), Task ID (rich text), Captured From (rich text)`,
        };
      }

      // Try to query the database (with limit to avoid fetching too much data)
      await this.callNotion(token, `/databases/${databaseId}/query`, "POST", {
        page_size: 1,
      });

      return {
        healthy: true,
        message: "Notion database accessible with required properties",
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Notion API error: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * Get database properties for setup guidance
   */
  async getDatabaseInfo(token: string, databaseId: string): Promise<{
    title: string;
    properties: Record<string, { type: string; [key: string]: any }>;
  }> {
    const database = await this.callNotion(token, `/databases/${databaseId}`);
    
    return {
      title: database.title?.[0]?.text?.content || "Untitled Database",
      properties: database.properties || {},
    };
  }
}

export const notionClient = new NotionClient();