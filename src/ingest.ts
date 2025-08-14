import * as fs from "fs";
import * as path from "path";
import { stateManager } from "./state";
import { logger } from "./log";

// Utility function to safely extract error messages
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export interface FileContent {
  filePath: string;
  content: string;
  modifiedTime: number;
  isModified: boolean;
}

export interface FileChunk {
  filePath: string;
  content: string;
  chunkIndex: number;
  totalChunks: number;
}

class FileIngester {
  private maxChunkSize = 8000; // Characters per chunk to stay under token limits

  /**
   * Expand tilde in file paths to user home directory
   */
  private expandPath(filePath: string): string {
    if (filePath.startsWith("~/")) {
      const os = require("os");
      return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
  }

  /**
   * Scan directory for markdown files
   */
  async scanDirectory(dirPath: string): Promise<string[]> {
    const expandedPath = this.expandPath(dirPath);
    
    try {
      if (!fs.existsSync(expandedPath)) {
        throw new Error(`Directory does not exist: ${expandedPath}`);
      }

      const stats = fs.statSync(expandedPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${expandedPath}`);
      }

      const files = fs.readdirSync(expandedPath);
      const markdownFiles = files
        .filter((file) => file.endsWith(".md"))
        .map((file) => path.join(expandedPath, file));

      logger.debug("Scanned directory for markdown files", {
        directory: expandedPath,
        fileCount: markdownFiles.length,
        files: markdownFiles.map(f => path.basename(f))
      });

      return markdownFiles;
    } catch (error) {
      logger.error("Failed to scan directory", { 
        directory: expandedPath, 
        error: getErrorMessage(error) 
      });
      throw error;
    }
  }

  /**
   * Read and process files, only returning modified ones
   */
  async readFiles(filePaths: string[]): Promise<FileContent[]> {
    const results: FileContent[] = [];

    for (const filePath of filePaths) {
      try {
        const stats = fs.statSync(filePath);
        const isModified = stateManager.isFileModified(filePath);
        
        if (!isModified) {
          logger.debug("Skipping unmodified file", { filePath });
          continue;
        }

        const content = fs.readFileSync(filePath, "utf8");
        
        results.push({
          filePath,
          content,
          modifiedTime: stats.mtimeMs,
          isModified: true,
        });

        logger.debug("Read modified file", { 
          filePath: path.basename(filePath), 
          size: content.length,
          lines: content.split("\n").length
        });

      } catch (error) {
        logger.warn("Failed to read file", { 
          filePath, 
          error: getErrorMessage(error) 
        });
      }
    }

    return results;
  }

  /**
   * Chunk large files to stay within token limits
   */
  chunkContent(fileContent: FileContent): FileChunk[] {
    if (fileContent.content.length <= this.maxChunkSize) {
      return [{
        filePath: fileContent.filePath,
        content: fileContent.content,
        chunkIndex: 0,
        totalChunks: 1,
      }];
    }

    const chunks: FileChunk[] = [];
    const lines = fileContent.content.split("\n");
    let currentChunk = "";
    let chunkIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const newChunk = currentChunk ? `${currentChunk}\n${line}` : line;

      if (newChunk.length > this.maxChunkSize && currentChunk) {
        // Current chunk is full, save it and start a new one
        chunks.push({
          filePath: fileContent.filePath,
          content: currentChunk,
          chunkIndex,
          totalChunks: 0, // Will be updated after all chunks are created
        });
        
        currentChunk = line;
        chunkIndex++;
      } else {
        currentChunk = newChunk;
      }
    }

    // Add the last chunk if it has content
    if (currentChunk) {
      chunks.push({
        filePath: fileContent.filePath,
        content: currentChunk,
        chunkIndex,
        totalChunks: 0,
      });
    }

    // Update total chunks count
    const totalChunks = chunks.length;
    chunks.forEach(chunk => {
      chunk.totalChunks = totalChunks;
    });

    logger.debug("Chunked large file", {
      filePath: path.basename(fileContent.filePath),
      originalSize: fileContent.content.length,
      chunks: totalChunks,
    });

    return chunks;
  }

  /**
   * Main ingestion method - scan directory and return processable chunks
   */
  async ingestFiles(dirPath: string): Promise<FileChunk[]> {
    logger.info("Starting file ingestion", { directory: dirPath });

    try {
      // Scan for markdown files
      const filePaths = await this.scanDirectory(dirPath);
      
      if (filePaths.length === 0) {
        logger.info("No markdown files found in directory");
        return [];
      }

      // Read only modified files
      const fileContents = await this.readFiles(filePaths);
      
      if (fileContents.length === 0) {
        logger.info("No modified files to process");
        return [];
      }

      // Chunk large files
      const allChunks: FileChunk[] = [];
      
      for (const fileContent of fileContents) {
        const chunks = this.chunkContent(fileContent);
        allChunks.push(...chunks);
        
        // Update file modified time after successful processing
        stateManager.updateFileModifiedTime(fileContent.filePath);
      }

      logger.info("File ingestion completed", {
        totalFiles: filePaths.length,
        modifiedFiles: fileContents.length,
        totalChunks: allChunks.length,
      });

      return allChunks;

    } catch (error) {
      logger.error("File ingestion failed", { 
        directory: dirPath, 
        error: getErrorMessage(error) 
      });
      throw error;
    }
  }

  /**
   * Health check - verify directory exists and is accessible
   */
  async healthCheck(dirPath: string): Promise<{ healthy: boolean; message: string }> {
    try {
      const expandedPath = this.expandPath(dirPath);
      
      if (!fs.existsSync(expandedPath)) {
        return {
          healthy: false,
          message: `Directory does not exist: ${expandedPath}`,
        };
      }

      const stats = fs.statSync(expandedPath);
      if (!stats.isDirectory()) {
        return {
          healthy: false,
          message: `Path is not a directory: ${expandedPath}`,
        };
      }

      // Try to read the directory
      fs.readdirSync(expandedPath);

      return {
        healthy: true,
        message: `Directory accessible: ${expandedPath}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Directory access error: ${getErrorMessage(error)}`,
      };
    }
  }
}

export const fileIngester = new FileIngester();