import { LogEntry } from "../types/index.js";

type LogLevel = LogEntry["level"];

export class Logger {
  private debugEnabled = false;
  private entries: LogEntry[] = [];
  private readonly maxEntries = 1000;

  setDebugMode(enabled: boolean) {
    this.debugEnabled = enabled;
  }

  getLogs(level?: LogLevel, limit = 100): LogEntry[] {
    const filtered = level
      ? this.entries.filter((entry) => entry.level === level)
      : this.entries;
    return filtered.slice(-limit);
  }

  debug(message: string, scope = "app", details?: unknown) {
    if (!this.debugEnabled) {
      return;
    }
    this.write("debug", message, scope, details);
  }

  info(message: string, scope = "app", details?: unknown) {
    this.write("info", message, scope, details);
  }

  warn(message: string, scope = "app", details?: unknown) {
    this.write("warn", message, scope, details);
  }

  error(message: string, scope = "app", details?: unknown) {
    this.write("error", message, scope, details);
  }

  private write(level: LogLevel, message: string, scope: string, details?: unknown) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      details,
    };
    this.entries.push(entry);
    // Trim buffer to prevent memory leak
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    const prefix = `[${entry.timestamp}] [${scope}]`;
    const serializedDetails = details ? ` ${safeStringify(details)}` : "";

    switch (level) {
      case "debug":
        console.debug(`${prefix} ${message}${serializedDetails}`);
        break;
      case "info":
        console.info(`${prefix} ${message}${serializedDetails}`);
        break;
      case "warn":
        console.warn(`${prefix} ${message}${serializedDetails}`);
        break;
      case "error":
        console.error(`${prefix} ${message}${serializedDetails}`);
        break;
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export const logger = new Logger();
