import { LaunchProps, getPreferenceValues, clearSearchBar } from "@raycast/api";
import { fileIngester } from "./ingest";
import { taskExtractor } from "./extractor";
import { notionClient } from "./notion";
import { stateManager, TaskWithMeta } from "./state";

// Utility functions to safely extract error information
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack;
  return undefined;
}
import { logger } from "./log";

interface Preferences {
  inboxDir: string;
  openaiKey: string;
  openaiModel: string;
  notionToken: string;
  notionDbId: string;
  enableScheduled: boolean;
}

export default async function Command(props: LaunchProps) {
  const startTime = Date.now();
  logger.info("Hourly sync started");

  try {
    const preferences = getPreferenceValues<Preferences>();
    
    // Check if scheduled sync is enabled
    if (!preferences.enableScheduled) {
      logger.info("Scheduled sync is disabled, exiting");
      return;
    }

    await clearSearchBar();

    // Health checks first
    const healthResults = await performHealthChecks(preferences);
    if (!healthResults.allHealthy) {
      logger.error("Health checks failed", { issues: healthResults.issues });
      return;
    }

    // Ingest files
    logger.info("Starting file ingestion");
    const chunks = await fileIngester.ingestFiles(preferences.inboxDir);
    
    if (chunks.length === 0) {
      logger.info("No files to process, sync completed");
      stateManager.updateLastRun();
      return;
    }

    // Extract tasks
    logger.info("Starting task extraction");
    const extractionResults = await taskExtractor.extractTasksFromChunks(
      chunks,
      preferences.openaiKey,
      preferences.openaiModel
    );

    // Flatten and deduplicate tasks
    const allTasks: TaskWithMeta[] = [];
    
    for (const result of extractionResults) {
      for (let i = 0; i < result.tasks.length; i++) {
        const task = result.tasks[i];
        const hash = stateManager.generateTaskHash(task, result.chunk.filePath, i);
        
        if (stateManager.isTaskProcessed(hash)) {
          logger.debug("Skipping already processed task", { 
            title: task.title.substring(0, 50),
            hash 
          });
          continue;
        }

        const taskWithMeta: TaskWithMeta = {
          ...task,
          hash,
          filePath: result.chunk.filePath,
          lineIndex: i,
          extractedAt: new Date().toISOString(),
        };

        allTasks.push(taskWithMeta);
      }
    }

    if (allTasks.length === 0) {
      logger.info("No new tasks to sync");
      stateManager.updateLastRun();
      return;
    }

    // Sync to Notion
    logger.info("Starting Notion sync", { taskCount: allTasks.length });
    const syncResults = await notionClient.syncTasks(
      preferences.notionToken,
      preferences.notionDbId,
      allTasks
    );

    // Mark successfully synced tasks as processed
    let successCount = 0;
    for (let i = 0; i < syncResults.length; i++) {
      const result = syncResults[i];
      const task = allTasks[i];
      
      if (result.success) {
        stateManager.markTaskProcessed(task.hash);
        successCount++;
      }
    }

    // Clean up old state entries
    stateManager.cleanup();
    
    // Update last run time
    stateManager.updateLastRun();

    const duration = Date.now() - startTime;
    
    logger.info("Hourly sync completed successfully", {
      processedChunks: chunks.length,
      extractedTasks: allTasks.length,
      syncedTasks: successCount,
      failedTasks: allTasks.length - successCount,
      durationMs: duration,
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error("Hourly sync failed", {
      error: getErrorMessage(error),
      stack: getErrorStack(error),
      durationMs: duration,
    });
  }
}

async function performHealthChecks(preferences: Preferences): Promise<{
  allHealthy: boolean;
  issues: string[];
}> {
  const issues: string[] = [];

  // Check preferences
  if (!preferences.inboxDir) {
    issues.push("Inbox directory not configured");
  }
  if (!preferences.openaiKey) {
    issues.push("OpenAI API key not configured");
  }
  if (!preferences.openaiModel) {
    issues.push("OpenAI model not configured");
  }
  if (!preferences.notionToken) {
    issues.push("Notion token not configured");
  }
  if (!preferences.notionDbId) {
    issues.push("Notion database ID not configured");
  }

  if (issues.length > 0) {
    return { allHealthy: false, issues };
  }

  // Check file system access
  const fileSystemCheck = await fileIngester.healthCheck(preferences.inboxDir);
  if (!fileSystemCheck.healthy) {
    issues.push(`File system: ${fileSystemCheck.message}`);
  }

  // Check OpenAI API (quick test)
  try {
    const openaiCheck = await taskExtractor.healthCheck(
      preferences.openaiKey,
      preferences.openaiModel
    );
    if (!openaiCheck.healthy) {
      issues.push(`OpenAI: ${openaiCheck.message}`);
    }
  } catch (error) {
    issues.push(`OpenAI: ${getErrorMessage(error)}`);
  }

  // Check Notion API
  try {
    const notionCheck = await notionClient.healthCheck(
      preferences.notionToken,
      preferences.notionDbId
    );
    if (!notionCheck.healthy) {
      issues.push(`Notion: ${notionCheck.message}`);
    }
  } catch (error) {
    issues.push(`Notion: ${getErrorMessage(error)}`);
  }

  return { allHealthy: issues.length === 0, issues };
}