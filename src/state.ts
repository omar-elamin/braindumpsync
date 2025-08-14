import { environment } from "@raycast/api";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { logger } from "./log";

// Utility function to safely extract error messages
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export interface ExtractedTask {
  title: string;
  due: string | null;
  tags: string[] | null;
}

export interface TaskWithMeta extends ExtractedTask {
  hash: string;
  filePath: string;
  lineIndex: number;
  extractedAt: string;
}

export interface AppState {
  lastRun: string | null;
  processedTasks: Set<string>;
  lastModifiedTimes: Record<string, number>;
}

class StateManager {
  private stateFilePath: string;
  private state: AppState;

  constructor() {
    this.stateFilePath = path.join(environment.supportPath, "state.json");
    this.state = this.loadState();
  }

  private loadState(): AppState {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const content = fs.readFileSync(this.stateFilePath, "utf8");
        const parsed = JSON.parse(content);
        
        // Convert processedTasks array back to Set if it exists
        const processedTasks = Array.isArray(parsed.processedTasks) 
          ? new Set<string>(parsed.processedTasks)
          : new Set<string>();

        return {
          lastRun: parsed.lastRun || null,
          processedTasks,
          lastModifiedTimes: parsed.lastModifiedTimes || {},
        };
      }
    } catch (error) {
      logger.warn("Failed to load state, starting fresh", { error: getErrorMessage(error) });
    }

    return {
      lastRun: null,
      processedTasks: new Set<string>(),
      lastModifiedTimes: {},
    };
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const serialisableState = {
        lastRun: this.state.lastRun,
        processedTasks: Array.from(this.state.processedTasks),
        lastModifiedTimes: this.state.lastModifiedTimes,
      };

      fs.writeFileSync(this.stateFilePath, JSON.stringify(serialisableState, null, 2), "utf8");
      logger.debug("State saved successfully", { taskCount: this.state.processedTasks.size });
    } catch (error) {
      logger.error("Failed to save state", { error: getErrorMessage(error) });
      throw new Error(`Failed to save state: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Generate a stable hash for a task based on its content and location
   */
  generateTaskHash(task: ExtractedTask, filePath: string, lineIndex: number): string {
    const hashInput = JSON.stringify({
      title: task.title.trim().toLowerCase(),
      filePath: path.resolve(filePath),
      lineIndex,
    });
    
    return crypto.createHash("sha256").update(hashInput).digest("hex").substring(0, 16);
  }

  /**
   * Check if a task has already been processed
   */
  isTaskProcessed(hash: string): boolean {
    return this.state.processedTasks.has(hash);
  }

  /**
   * Mark a task as processed
   */
  markTaskProcessed(hash: string): void {
    this.state.processedTasks.add(hash);
  }

  /**
   * Check if a file has been modified since last processing
   */
  isFileModified(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath);
      const currentMtime = stats.mtimeMs;
      const lastMtime = this.state.lastModifiedTimes[filePath];
      
      if (!lastMtime) {
        return true; // Never processed before
      }
      
      return currentMtime > lastMtime;
    } catch (error) {
      logger.warn("Failed to check file modification time", { filePath, error: getErrorMessage(error) });
      return true; // Assume modified if we can't check
    }
  }

  /**
   * Update the last modified time for a file
   */
  updateFileModifiedTime(filePath: string): void {
    try {
      const stats = fs.statSync(filePath);
      this.state.lastModifiedTimes[filePath] = stats.mtimeMs;
    } catch (error) {
      logger.warn("Failed to update file modified time", { filePath, error: getErrorMessage(error) });
    }
  }

  /**
   * Get the last run timestamp
   */
  getLastRun(): string | null {
    return this.state.lastRun;
  }

  /**
   * Update the last run timestamp and save state
   */
  updateLastRun(): void {
    this.state.lastRun = new Date().toISOString();
    this.saveState();
  }

  /**
   * Get count of processed tasks
   */
  getProcessedTaskCount(): number {
    return this.state.processedTasks.size;
  }

  /**
   * Clean up old entries to prevent state file from growing indefinitely
   */
  cleanup(maxEntries = 10000): void {
    let needsSave = false;

    if (this.state.processedTasks.size > maxEntries) {
      const tasksArray = Array.from(this.state.processedTasks);
      const keepTasks = tasksArray.slice(-Math.floor(maxEntries * 0.8)); // Keep 80% of max
      this.state.processedTasks = new Set(keepTasks);
      logger.info("Cleaned up old task entries", { 
        removed: tasksArray.length - keepTasks.length,
        remaining: keepTasks.length 
      });
      needsSave = true;
    }

    // Clean up old file modification times (keep only files from last 30 days)
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const filesToRemove: string[] = [];
    
    for (const [filePath, mtime] of Object.entries(this.state.lastModifiedTimes)) {
      if (mtime < thirtyDaysAgo) {
        filesToRemove.push(filePath);
      }
    }
    
    filesToRemove.forEach(filePath => {
      delete this.state.lastModifiedTimes[filePath];
    });
    
    if (filesToRemove.length > 0) {
      logger.info("Cleaned up old file modification times", { removed: filesToRemove.length });
      needsSave = true;
    }
    
    // Save state after cleanup if anything changed
    if (needsSave) {
      this.saveState();
    }
  }

  /**
   * Force save current state
   */
  save(): void {
    this.saveState();
  }

  /**
   * Reset all state (for testing or debugging)
   */
  reset(): void {
    this.state = this.loadState();
    this.saveState();
  }
}

export const stateManager = new StateManager();