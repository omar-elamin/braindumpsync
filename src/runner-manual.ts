import { 
  LaunchProps, 
  getPreferenceValues, 
  showToast, 
  Toast, 
  clearSearchBar, 
  showHUD 
} from "@raycast/api";
import { fileIngester } from "./ingest";
import { taskExtractor } from "./extractor";

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
import { notionClient } from "./notion";
import { stateManager, TaskWithMeta } from "./state";
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
  
  await clearSearchBar();
  await showToast({
    style: Toast.Style.Animated,
    title: "Starting sync...",
    message: "Checking configuration and health",
  });

  logger.info("Manual sync started");

  try {
    const preferences = getPreferenceValues<Preferences>();

    // Health checks first
    await showToast({
      style: Toast.Style.Animated,
      title: "Checking health...",
      message: "Verifying API connections",
    });

    const healthResults = await performHealthChecks(preferences);
    if (!healthResults.allHealthy) {
      const errorMessage = healthResults.issues.join("; ");
      await showToast({
        style: Toast.Style.Failure,
        title: "Configuration Error",
        message: errorMessage,
      });
      logger.error("Health checks failed", { issues: healthResults.issues });
      return;
    }

    // Ingest files
    await showToast({
      style: Toast.Style.Animated,
      title: "Scanning files...",
      message: "Looking for modified markdown files",
    });

    const chunks = await fileIngester.ingestFiles(preferences.inboxDir);
    
    if (chunks.length === 0) {
      await showHUD("✅ No new files to process");
      logger.info("No files to process, sync completed");
      stateManager.updateLastRun();
      return;
    }

    // Extract tasks
    await showToast({
      style: Toast.Style.Animated,
      title: "Extracting tasks...",
      message: `Processing ${chunks.length} file chunk${chunks.length === 1 ? "" : "s"}`,
    });

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
      await showHUD("✅ No new tasks found");
      logger.info("No new tasks to sync");
      stateManager.updateLastRun();
      return;
    }

    // Sync to Notion
    await showToast({
      style: Toast.Style.Animated,
      title: "Syncing to Notion...",
      message: `Creating ${allTasks.length} task${allTasks.length === 1 ? "" : "s"}`,
    });

    const syncResults = await notionClient.syncTasks(
      preferences.notionToken,
      preferences.notionDbId,
      allTasks
    );

    // Mark successfully synced tasks as processed
    let successCount = 0;
    let failedCount = 0;
    
    for (let i = 0; i < syncResults.length; i++) {
      const result = syncResults[i];
      const task = allTasks[i];
      
      if (result.success) {
        stateManager.markTaskProcessed(task.hash);
        successCount++;
      } else {
        failedCount++;
        logger.warn("Task sync failed", {
          title: task.title,
          error: result.error,
        });
      }
    }

    // Clean up old state entries
    stateManager.cleanup();
    
    // Update last run time
    stateManager.updateLastRun();

    const duration = Date.now() - startTime;

    // Show final result
    if (failedCount === 0) {
      await showHUD(`✅ Synced ${successCount} task${successCount === 1 ? "" : "s"} to Notion`);
    } else {
      await showToast({
        style: Toast.Style.Success,
        title: "Sync completed with warnings",
        message: `✅ ${successCount} synced, ⚠️ ${failedCount} failed`,
      });
    }
    
    logger.info("Manual sync completed successfully", {
      processedChunks: chunks.length,
      extractedTasks: allTasks.length,
      syncedTasks: successCount,
      failedTasks: failedCount,
      durationMs: duration,
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    
    await showToast({
      style: Toast.Style.Failure,
      title: "Sync Failed",
      message: getErrorMessage(error),
    });

    logger.error("Manual sync failed", {
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