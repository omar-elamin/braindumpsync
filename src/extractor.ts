import { ExtractedTask } from "./state";
import { FileChunk } from "./ingest";
import { logger } from "./log";

// Utility function to safely extract error messages
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

// Utility function to safely extract error stack
function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack;
  return undefined;
}

export interface ExtractionResult {
  tasks: ExtractedTask[];
  chunk: FileChunk;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface OpenAIError {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

class TaskExtractor {
  private baseUrl = "https://api.openai.com/v1/chat/completions";

  /**
   * Build the system prompt for task extraction
   */
  private buildSystemPrompt(): string {
    return `Extract actionable tasks from timestamped braindump notes. Return only JSON.

<source_format>
Daily markdown files (YYYY-MM-DD.md) with timestamped entries:
## HH:MM:SS
- Random thoughts, todos, feelings, reminders, etc.
</source_format>

<what_to_extract>
Extract only actionable items:
- Tasks, todos, action items, reminders with action required
- Ignore: completed tasks, thoughts, feelings, observations
- Preserve context and proper names
- Use imperative titles
- Current year: ${new Date().getFullYear()}
</what_to_extract>

<due_date_extraction_rules>
- Extract specific times when mentioned (e.g., "call at 3pm", "meeting at 9:30am")
- For "tomorrow", "today", "Friday" etc., add a specific time if context suggests one
- Default to 09:00 for morning tasks, 14:00 for afternoon tasks, 17:00 for end-of-day
- Use entry timestamp as context for timing (early entries = morning tasks)
- Format: "YYYY-MM-DDTHH:MM" in 24-hour format
</due_date_extraction_rules>

<return_format>
{
  "tasks": [
    {
      "title": "string",
      "due": "YYYY-MM-DDTHH:MM" | "YYYY-MM-DD" | null,
      "tags": ["string"] | null
    }
  ]
}
</return_format>
`;
  }

  /**
   * Build user prompt with file content
   */
  private buildUserPrompt(chunk: FileChunk): string {
    const chunkInfo = chunk.totalChunks > 1
      ? ` (chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks})`
      : "";

    return `Extract from braindump${chunkInfo}:

<braindump>
${chunk.content}
</braindump>

<current_datetime>
Important: Use this for reference when extracting due dates.
Date: ${new Date().toISOString().split('T')[0]}
Time: ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
</current_datetime>

<examples>
Extract actionable tasks like:
✓ - [ ] Buy milk
✓ - call John tomorrow at 2pm
✓ TODO: send invoice due:16/08 9am
✓ remind Sarah about meeting at 10:30
✓ need to review proposal by end of day
✓ dentist appointment Friday 3pm
✓ follow up call at 9am

Ignore non-actionable:
✗ - [x] completed tasks
✗ feeling tired today
✗ random observation

Time extraction examples:
"call at 3pm" → "2025-01-15T15:00"
"meeting tomorrow 9:30am" → "2025-01-16T09:30"
"deadline Friday" → "2025-01-17T17:00"
"follow up today" → "2025-01-15T14:00" (use entry time context)
</examples>

JSON only:`;
  }

  /**
   * Normalise date strings to YYYY-MM-DD format
   */
  private normaliseDate(dateStr: string): string | null {
    if (!dateStr) return null;

    const currentYear = new Date().getFullYear();

    // Already in YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr;
    }

    // DD/MM or DD/M format
    const ddmmMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (ddmmMatch) {
      const day = ddmmMatch[1].padStart(2, '0');
      const month = ddmmMatch[2].padStart(2, '0');
      return `${currentYear}-${month}-${day}`;
    }

    return null;
  }

  /**
   * Validate and clean extracted tasks
   */
  private validateAndCleanTasks(rawTasks: any[]): ExtractedTask[] {
    if (!Array.isArray(rawTasks)) {
      return [];
    }

    return rawTasks
      .filter((task) => {
        return (
          task &&
          typeof task === "object" &&
          typeof task.title === "string" &&
          task.title.trim().length > 0
        );
      })
      .map((task) => ({
        title: task.title.trim(),
        due: task.due ? this.normaliseDate(task.due) : null,
        tags: Array.isArray(task.tags) ? task.tags.filter((tag: any) => typeof tag === "string") : null,
      }));
  }

  /**
   * Make API call to OpenAI
   */
  private async callOpenAI(
    apiKey: string,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    attempt = 1
  ): Promise<any> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_completion_tokens: 1500,
        text: {
          "format": {
            "type": "json_object"
          },
          "verbosity": "medium"
        },
        reasoning: {
          "effort": "medium",
          "summary": "auto"
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage = `HTTP ${response.status}`;

      try {
        const errorJson = JSON.parse(errorBody) as OpenAIError;
        errorMessage = errorJson.error?.message || errorMessage;
      } catch {
        // Use raw error body if JSON parsing fails
        errorMessage = errorBody || errorMessage;
      }

      // Handle rate limiting with exponential backoff
      if (response.status === 429 && attempt <= 3) {
        const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        logger.warn(`Rate limited, retrying in ${delayMs}ms`, { attempt });
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return this.callOpenAI(apiKey, model, systemPrompt, userPrompt, attempt + 1);
      }

      throw new Error(`OpenAI API error: ${errorMessage}`);
    }

    const data = await response.json() as OpenAIResponse;

    if (!data.choices || data.choices.length === 0) {
      throw new Error("No response from OpenAI API");
    }

    return data.choices[0].message.content;
  }

  /**
   * Parse JSON response with retry logic
   */
  private async parseJsonResponse(
    content: string,
    apiKey: string,
    model: string,
    chunk: FileChunk
  ): Promise<any> {
    try {
      return JSON.parse(content);
    } catch (parseError) {
      logger.warn("Failed to parse JSON response, retrying with stricter prompt", {
        chunkFile: chunk.filePath,
        parseError: getErrorMessage(parseError),
        responsePreview: content.substring(0, 200)
      });

      // Retry with a more specific prompt
      const strictPrompt = `The previous response was not valid JSON. Return ONLY a JSON object with this exact structure:
{
  "tasks": [
    {
      "title": "string",
      "due": "YYYY-MM-DD" | null,
      "tags": ["string"] | null
    }
  ]
}

Do not include any text before or after the JSON object.`;

      try {
        const retryContent = await this.callOpenAI(apiKey, model, strictPrompt, `Extract tasks from: ${chunk.content.substring(0, 1000)}`);
        return JSON.parse(retryContent);
      } catch (retryError) {
        logger.error("Failed to parse JSON after retry, skipping chunk", {
          chunkFile: chunk.filePath,
          originalError: getErrorMessage(parseError),
          retryError: getErrorMessage(retryError),
        });
        return { tasks: [] };
      }
    }
  }

  /**
   * Extract tasks from a file chunk
   */
  async extractTasks(
    chunk: FileChunk,
    apiKey: string,
    model: string
  ): Promise<ExtractionResult> {
    const startTime = Date.now();

    try {
      logger.debug("Starting task extraction", {
        file: chunk.filePath,
        chunk: chunk.totalChunks > 1 ? `${chunk.chunkIndex + 1}/${chunk.totalChunks}` : "1/1",
        contentLength: chunk.content.length,
      });

      const systemPrompt = this.buildSystemPrompt();
      const userPrompt = this.buildUserPrompt(chunk);

      logger.debug("Sending request to OpenAI", {
        file: chunk.filePath,
        model,
        systemPromptLength: systemPrompt.length,
        userPromptLength: userPrompt.length,
        userPromptPreview: userPrompt.substring(0, 200) + "..."
      });

      const responseContent = await this.callOpenAI(apiKey, model, systemPrompt, userPrompt);

      logger.debug("Received response from OpenAI", {
        file: chunk.filePath,
        responseLength: responseContent.length,
        responsePreview: responseContent.substring(0, 500) + "..."
      });

      const parsedResponse = await this.parseJsonResponse(responseContent, apiKey, model, chunk);

      const rawTasks = parsedResponse.tasks || [];
      const validTasks = this.validateAndCleanTasks(rawTasks);

      const duration = Date.now() - startTime;

      // Log the extracted tasks
      if (validTasks.length > 0) {
        logger.info("AI extracted tasks", {
          file: chunk.filePath,
          tasks: validTasks.map(task => ({
            title: task.title,
            due: task.due,
            tags: task.tags
          }))
        });
      }

      logger.debug("Task extraction completed", {
        file: chunk.filePath,
        chunk: chunk.totalChunks > 1 ? `${chunk.chunkIndex + 1}/${chunk.totalChunks}` : "1/1",
        rawTaskCount: rawTasks.length,
        validTaskCount: validTasks.length,
        durationMs: duration,
      });

      return {
        tasks: validTasks,
        chunk,
      };

    } catch (error) {
      logger.error("Task extraction failed", {
        file: chunk.filePath,
        chunk: chunk.totalChunks > 1 ? `${chunk.chunkIndex + 1}/${chunk.totalChunks}` : "1/1",
        error: getErrorMessage(error),
      });

      return {
        tasks: [],
        chunk,
      };
    }
  }

  /**
   * Extract tasks from multiple chunks in parallel
   */
  async extractTasksFromChunks(
    chunks: FileChunk[],
    apiKey: string,
    model: string,
    maxConcurrency = 3
  ): Promise<ExtractionResult[]> {
    logger.info("Starting batch task extraction", {
      chunkCount: chunks.length,
      maxConcurrency,
    });

    const results: ExtractionResult[] = [];

    // Process chunks in batches to avoid overwhelming the API
    for (let i = 0; i < chunks.length; i += maxConcurrency) {
      const batch = chunks.slice(i, i + maxConcurrency);

      const batchPromises = batch.map(chunk =>
        this.extractTasks(chunk, apiKey, model)
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Small delay between batches to be respectful to the API
      if (i + maxConcurrency < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const totalTasks = results.reduce((sum, result) => sum + result.tasks.length, 0);

    logger.info("Batch task extraction completed", {
      processedChunks: chunks.length,
      totalTasks,
    });

    return results;
  }

  /**
   * Health check - verify API key works
   */
  async healthCheck(apiKey: string, model: string): Promise<{ healthy: boolean; message: string }> {
    try {
      const testPrompt = "Return only this JSON: {\"test\": true}";

      const response = await this.callOpenAI(
        apiKey,
        model,
        "You are a test assistant. Return only the requested JSON.",
        testPrompt
      );

      const parsed = JSON.parse(response);

      if (parsed.test === true) {
        return { healthy: true, message: "OpenAI API connection successful" };
      } else {
        return { healthy: false, message: "OpenAI API returned unexpected response" };
      }
    } catch (error) {
      return { healthy: false, message: `OpenAI API error: ${getErrorMessage(error)}` };
    }
  }
}

export const taskExtractor = new TaskExtractor();