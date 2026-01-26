export interface SMTPConfig {
  host: string;
  port: number;
  secure: boolean;
  rejectUnauthorized: boolean;
  username: string;
  password: string;
}

export interface IMAPConfig {
  host: string;
  port: number;
  secure: boolean;
  rejectUnauthorized: boolean;
  username: string;
  password: string;
}

export interface MailConfig {
  smtp: SMTPConfig;
  imap: IMAPConfig;
  debug: boolean;
  cacheEnabled: boolean;
  analyticsEnabled: boolean;
  autoSync: boolean;
  syncIntervalSeconds: number;
}

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
  details?: unknown;
}
