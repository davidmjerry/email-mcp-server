import { logger } from "../utils/logger.js";

export interface EmailAnalyticsSnapshot {
  sentCount: number;
  receivedCount: number;
  lastUpdated: string;
}

export class AnalyticsService {
  private sentCount = 0;
  private receivedCount = 0;

  recordSentEmail(): void {
    this.sentCount += 1;
    logger.debug("📈 Recorded sent email", "AnalyticsService", {
      sentCount: this.sentCount,
    });
  }

  recordReceivedEmail(): void {
    this.receivedCount += 1;
    logger.debug("📈 Recorded received email", "AnalyticsService", {
      receivedCount: this.receivedCount,
    });
  }

  getSnapshot(): EmailAnalyticsSnapshot {
    return {
      sentCount: this.sentCount,
      receivedCount: this.receivedCount,
      lastUpdated: new Date().toISOString(),
    };
  }

  clear(): void {
    this.sentCount = 0;
    this.receivedCount = 0;
    logger.info("🧹 Cleared analytics", "AnalyticsService");
  }
}
