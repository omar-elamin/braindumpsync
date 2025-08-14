import { environment } from "@raycast/api";
import * as fs from "fs";
import * as path from "path";

export interface LogEntry {
  timestamp: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  message: string;
  data?: any;
}

class Logger {
  private logFilePath: string;
  private maxLogSize = 1024 * 1024; // 1MB

  constructor() {
    this.logFilePath = path.join(environment.supportPath, "brainpipe.log");
    this.ensureLogDirectory();
  }

  private ensureLogDirectory(): void {
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private rotateLogIfNeeded(): void {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const stats = fs.statSync(this.logFilePath);
        if (stats.size > this.maxLogSize) {
          const backupPath = this.logFilePath + ".old";
          if (fs.existsSync(backupPath)) {
            fs.unlinkSync(backupPath);
          }
          fs.renameSync(this.logFilePath, backupPath);
        }
      }
    } catch (error) {
      console.error("Failed to rotate log file:", error);
    }
  }

  private writeToFile(entry: LogEntry): void {
    // Skip file logging in test environment
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
      return;
    }
    
    try {
      this.rotateLogIfNeeded();
      const logLine = JSON.stringify(entry) + "\n";
      fs.appendFileSync(this.logFilePath, logLine, "utf8");
    } catch (error) {
      console.error("Failed to write to log file:", error);
    }
  }

  private log(level: LogEntry["level"], message: string, data?: any): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data: data ? this.sanitiseData(data) : undefined,
    };

    // Always log to Raycast console
    const consoleMessage = `[${entry.level}] ${entry.message}`;
    switch (level) {
      case "DEBUG":
        console.log(consoleMessage, data);
        break;
      case "INFO":
        console.info(consoleMessage, data);
        break;
      case "WARN":
        console.warn(consoleMessage, data);
        break;
      case "ERROR":
        console.error(consoleMessage, data);
        break;
    }

    // Write to file
    this.writeToFile(entry);
  }

  private sanitiseData(data: any): any {
    if (typeof data !== "object" || data === null) {
      return data;
    }

    const sanitised = { ...data };
    const sensitiveKeys = ["password", "token", "key", "secret", "auth"];

    const sanitiseObject = (obj: any): any => {
      if (typeof obj !== "object" || obj === null) {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map(sanitiseObject);
      }

      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (sensitiveKeys.some((sensitive) => key.toLowerCase().includes(sensitive))) {
          result[key] = "[REDACTED]";
        } else if (typeof value === "object") {
          result[key] = sanitiseObject(value);
        } else {
          result[key] = value;
        }
      }
      return result;
    };

    return sanitiseObject(sanitised);
  }

  debug(message: string, data?: any): void {
    this.log("DEBUG", message, data);
  }

  info(message: string, data?: any): void {
    this.log("INFO", message, data);
  }

  warn(message: string, data?: any): void {
    this.log("WARN", message, data);
  }

  error(message: string, data?: any): void {
    this.log("ERROR", message, data);
  }

  getLogPath(): string {
    return this.logFilePath;
  }

  getRecentLogs(lines = 100): LogEntry[] {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        return [];
      }

      const content = fs.readFileSync(this.logFilePath, "utf8");
      const logLines = content.trim().split("\n").filter(Boolean);
      const recentLines = logLines.slice(-lines);

      return recentLines
        .map((line) => {
          try {
            return JSON.parse(line) as LogEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is LogEntry => entry !== null);
    } catch (error) {
      console.error("Failed to read log file:", error);
      return [];
    }
  }
}

export const logger = new Logger();