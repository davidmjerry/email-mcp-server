#!/usr/bin/env node

/**
 * MCP Email Server
 *
 * Features:
 * ✅ Advanced email sending (SMTP) with templates & scheduling
 * ✅ Complete email reading (IMAP)
 * ✅ Comprehensive email statistics & analytics
 * ✅ Folder and label management
 * ✅ Contact management with interaction tracking
 * ✅ Email search with advanced filters
 * ✅ Attachment handling
 * ✅ Email threading and conversation management
 * ✅ Real-time synchronization
 * ✅ Performance monitoring and logging
 */

import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";

import { MailConfig } from "./types/index.js";
import { SMTPService } from "./services/smtp-service.js";
import { SimpleIMAPService } from "./services/simple-imap-service.js";
import { AnalyticsService } from "./services/analytics-service.js";
import { logger } from "./utils/logger.js";
import { parseEmails, isValidEmail } from "./utils/helpers.js";
import {
  assertNoUnknownKeys,
  normalizeDateRange,
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseDateInput,
  requireString,
} from "./utils/validation.js";

dotenv.config();

// Environment configuration
const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;
const SMTP_HOST = process.env.SMTP_HOST || "localhost";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_REJECT_UNAUTHORIZED = process.env.SMTP_REJECT_UNAUTHORIZED !== "false";
const SMTP_SECURE = parseOptionalBoolean(process.env.SMTP_SECURE);
const IMAP_HOST = process.env.IMAP_HOST || "localhost";
const IMAP_PORT = parseInt(process.env.IMAP_PORT || "1143", 10);
const IMAP_REJECT_UNAUTHORIZED = process.env.IMAP_REJECT_UNAUTHORIZED !== "false";
const IMAP_SECURE = parseOptionalBoolean(process.env.IMAP_SECURE);
const DEBUG = process.env.DEBUG === "true";

const MCP_HOST = process.env.MCP_HOST || "127.0.0.1";
const MCP_PORT = parseInt(process.env.MCP_PORT || "3000", 10);
const MCP_ALLOWED_HOSTS = process.env.MCP_ALLOWED_HOSTS
  ? process.env.MCP_ALLOWED_HOSTS.split(",").map((host) => host.trim()).filter(Boolean)
  : undefined;
const MCP_TOKEN = process.env.MCP_TOKEN;

// Server configuration constants
const CONNECTION_RETRY_MAX_ATTEMPTS = 3;
const CONNECTION_RETRY_BASE_DELAY_MS = 1000;
const CONNECTION_RETRY_MAX_DELAY_MS = 10_000;
const SSE_CONNECTION_TIMEOUT_MS = 30_000;

// Validate required environment variables
if (!USERNAME || !PASSWORD) {
  console.error("❌ Missing required environment variables: USERNAME and PASSWORD must be set");
  process.exit(1);
}

// Configure logger
logger.setDebugMode(DEBUG);

function parseOptionalBoolean(value?: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === "true";
}

const getTokenFromRequest = (req: Request): string | undefined => {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  const headerToken = req.headers["x-mcp-token"];
  if (typeof headerToken === "string") {
    return headerToken.trim();
  }

  const queryToken = req.query.token;
  if (typeof queryToken === "string") {
    return queryToken.trim();
  }

  return undefined;
};

const sleep = (ms: number) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const withTimeout = async <T>(label: string, work: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const getErrorCode = (error: unknown): string | undefined => {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
};

const mapServiceError = (error: unknown): { mcpError?: McpError; retryable: boolean; message: string; code?: string } => {
  const message = getErrorMessage(error);
  const code = getErrorCode(error);
  const normalizedMessage = message.toLowerCase();
  const normalizedCode = code?.toLowerCase();
  const normalizedCodeToken = normalizedCode?.replace(/\s+/g, "");

  const authCodes = new Set(["eauth", "auth", "authenticationfailed"]);
  const isAuthError = normalizedMessage.includes("auth")
    || normalizedMessage.includes("authentication")
    || normalizedMessage.includes("login")
    || (normalizedCodeToken ? authCodes.has(normalizedCodeToken) : false);

  if (isAuthError) {
    return {
      mcpError: new McpError(ErrorCode.InvalidRequest, "Authentication failed while contacting the mail server"),
      retryable: false,
      message,
      code,
    };
  }

  if (
    normalizedMessage.includes("not found")
    || normalizedMessage.includes("mailbox")
    || normalizedMessage.includes("folder")
    || normalizedMessage.includes("trash folder")
  ) {
    return {
      mcpError: new McpError(ErrorCode.InvalidParams, message),
      retryable: false,
      message,
      code,
    };
  }

  const transientCodes = new Set([
    "etimedout",
    "econnreset",
    "econnrefused",
    "ehostunreach",
    "enotfound",
    "eai_again",
    "enetwork",
  ]);
  const isTransient = (normalizedCodeToken && transientCodes.has(normalizedCodeToken))
    || normalizedMessage.includes("timeout")
    || normalizedMessage.includes("timed out")
    || normalizedMessage.includes("temporarily")
    || normalizedMessage.includes("connection reset")
    || normalizedMessage.includes("network");

  return {
    retryable: isTransient,
    message,
    code,
  };
};

const requireToken = (req: Request, res: Response): boolean => {
  if (!MCP_TOKEN) {
    return true;
  }

  const token = getTokenFromRequest(req);
  if (token && token === MCP_TOKEN) {
    return true;
  }

  logger.warn("Unauthorized MCP request rejected", "MCPServer", {
    path: req.path,
    ip: req.ip,
  });
  res.status(401).send("Unauthorized");
  return false;
};

const verifySmtpWithRetry = async (maxAttempts: number): Promise<boolean> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await smtpService.verifyConnection();
      return true;
    } catch (error) {
      logger.warn(`SMTP verification attempt ${attempt} failed`, "MCPServer", error);
      if (attempt < maxAttempts) {
        const backoffMs = Math.min(CONNECTION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), CONNECTION_RETRY_MAX_DELAY_MS);
        const jitter = 0.5 + Math.random();
        await sleep(Math.round(backoffMs * jitter));
      }
    }
  }
  return false;
};

const connectImapWithRetry = async (maxAttempts: number): Promise<boolean> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await imapService.connect();
      return true;
    } catch (error) {
      logger.warn(`IMAP connection attempt ${attempt} failed`, "MCPServer", error);
      if (attempt < maxAttempts) {
        const backoffMs = Math.min(CONNECTION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), CONNECTION_RETRY_MAX_DELAY_MS);
        const jitter = 0.5 + Math.random();
        await sleep(Math.round(backoffMs * jitter));
      }
    }
  }
  return false;
};

// Create configuration
const config: MailConfig = {
  smtp: {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE ?? SMTP_PORT === 465,
    rejectUnauthorized: SMTP_REJECT_UNAUTHORIZED,
    username: USERNAME,
    password: PASSWORD,
  },
  imap: {
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_SECURE ?? false,
    rejectUnauthorized: IMAP_REJECT_UNAUTHORIZED,
    username: USERNAME,
    password: PASSWORD,
  },
  debug: DEBUG,
  cacheEnabled: true,
  analyticsEnabled: true,
  autoSync: true,
  syncIntervalSeconds: 15,
};

// Initialize services
const smtpService = new SMTPService(config);
const imapService = new SimpleIMAPService(config);
const analyticsService = new AnalyticsService();

const toolDefinitions = [
  // 📧 EMAIL SENDING TOOLS
  {
    name: "send_email",
    description: "🚀 Send email with advanced options (templates, scheduling, attachments)",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address(es), comma-separated" },
        cc: { type: "string", description: "CC recipients, comma-separated" },
        bcc: { type: "string", description: "BCC recipients, comma-separated" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body content" },
        template: { type: "string", description: "Optional template string with {{placeholders}}" },
        templateData: { type: "object", description: "Template data for placeholder interpolation" },
        isHtml: { type: "boolean", description: "Whether body is HTML", default: false },
        priority: { type: "string", enum: ["high", "normal", "low"], description: "Email priority" },
        replyTo: { type: "string", description: "Reply-to email address" },
        requestReadReceipt: { type: "boolean", description: "Request read receipt", default: false },
        scheduleAt: { type: "string", description: "Schedule send at ISO datetime" },
        scheduleDelayMinutes: { type: "number", description: "Delay send by N minutes" },
        attachments: {
          type: "array",
          description: "File attachments (base64 encoded)",
          items: {
            type: "object",
            properties: {
              filename: { type: "string", description: "Attachment filename" },
              content: { type: "string", description: "Base64-encoded content" },
              encoding: { type: "string", description: "Content encoding (default: base64)" },
              contentType: { type: "string", description: "MIME content type" }
            },
            required: ["filename", "content"],
            additionalProperties: false
          }
        }
      },
      required: ["to", "subject"],
      additionalProperties: false
    }
  },
  {
    name: "send_test_email",
    description: "🧪 Send a test email to verify SMTP functionality",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Test recipient email address" },
        customMessage: { type: "string", description: "Custom test message" }
      },
      required: ["to"],
      additionalProperties: false
    }
  },

  // 📬 EMAIL READING TOOLS
  {
    name: "get_emails",
    description: "📬 Get emails from a specific folder with pagination",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" },
        limit: { type: "number", description: "Number of emails to fetch", default: 50 },
        offset: { type: "number", description: "Pagination offset", default: 0 }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_email_by_id",
    description: "📧 Get a specific email by its ID",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" },
        emailId: { type: "string", description: "Email ID to retrieve" }
      },
      required: ["emailId"],
      additionalProperties: false
    }
  },
  {
    name: "search_emails",
    description: "🔍 Search emails with advanced filters",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        folder: { type: "string", description: "Folder to search in" },
        from: { type: "string", description: "Filter by sender" },
        to: { type: "string", description: "Filter by recipient" },
        subject: { type: "string", description: "Filter by subject" },
        hasAttachment: { type: "boolean", description: "Filter emails with attachments" },
        isRead: { type: "boolean", description: "Filter by read status" },
        isStarred: { type: "boolean", description: "Filter starred emails" },
        dateFrom: { type: "string", description: "Start date (ISO format)" },
        dateTo: { type: "string", description: "End date (ISO format)" },
        limit: { type: "number", description: "Max results", default: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_thread",
    description: "🧵 Get all emails in a thread using a threadId",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" },
        threadId: { type: "string", description: "Thread ID from references/in-reply-to headers" },
        limit: { type: "number", description: "Max emails to return", default: 200 }
      },
      required: ["threadId"],
      additionalProperties: false
    }
  },

  // 📁 FOLDER MANAGEMENT TOOLS
  {
    name: "get_folders",
    description: "📁 Get all email folders with statistics",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  // ⚡ EMAIL ACTIONS
  {
    name: "mark_email_read",
    description: "✅ Mark one or many emails as read/unread in a single call (use emailIds with a single-item array for single updates)",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" },
        emailIds: {
          type: "array",
          description: "Batch of email IDs to mark read/unread",
          items: { type: ["string", "number"] }
        },
        isRead: { type: "boolean", description: "Read status", default: true }
      },
      required: ["emailIds"],
      additionalProperties: false
    }
  },
  {
    name: "star_email",
    description: "⭐ Star/unstar one or many emails in a single call (use emailIds with a single-item array for single updates)",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" },
        emailIds: {
          type: "array",
          description: "Batch of email IDs to star/unstar",
          items: { type: ["string", "number"] }
        },
        isStarred: { type: "boolean", description: "Star status", default: true }
      },
      required: ["emailIds"],
      additionalProperties: false
    }
  },
  {
    name: "move_email",
    description: "📦 Move one or many emails to a different folder in a single call (use emailIds with a single-item array for single moves)",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" },
        emailIds: {
          type: "array",
          description: "Batch of email IDs to move",
          items: { type: ["string", "number"] }
        },
        targetFolder: { type: "string", description: "Target folder name" }
      },
      required: ["emailIds", "targetFolder"],
      additionalProperties: false
    }
  },
  {
    name: "delete_email",
    description: "🗑️ Delete one or many emails permanently in a single call (use emailIds with a single-item array for single deletes)",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" },
        emailIds: {
          type: "array",
          description: "Batch of email IDs to delete",
          items: { type: ["string", "number"] }
        }
      },
      required: ["emailIds"],
      additionalProperties: false
    }
  },

  // 📊 ANALYTICS & STATISTICS TOOLS
  {
    name: "get_email_analytics",
    description: "📊 Get comprehensive email statistics and analytics including mailbox status",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_contacts",
    description: "👥 Get contact information with interaction statistics",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" },
        limit: { type: "number", description: "Max contacts to return", default: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_volume_trends",
    description: "📉 Get email volume trends over time",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name (default: INBOX)", default: "INBOX" },
        days: { type: "number", description: "Number of days to analyze", default: 30 }
      },
      additionalProperties: false
    }
  },

];

const getArguments = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

const parseEmailIdValue = (value: unknown, label: string, toolName: string): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new McpError(ErrorCode.InvalidParams, `${toolName} requires ${label} to be a numeric emailId`);
};

const parseEmailIds = (args: Record<string, unknown>, toolName: string): number[] => {
  if (Array.isArray(args.emailIds)) {
    if (args.emailIds.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, `${toolName} requires emailIds to be a non-empty array`);
    }
    return args.emailIds.map((value, index) => parseEmailIdValue(value, `emailIds[${index}]`, toolName));
  }
  throw new McpError(ErrorCode.InvalidParams, `${toolName} requires emailIds`);
};

/**
 * Helper for batch email operations with partial failure handling.
 * Runs operations in parallel, logs failures, and returns succeeded IDs with failure count.
 */
const runBatchEmailOperation = async <T extends Record<string, unknown>>(
  emailIds: number[],
  operation: (emailId: number) => Promise<unknown>,
  toolName: string,
  logContext: T,
): Promise<{ succeeded: number[]; failedCount: number }> => {
  const results = await Promise.allSettled(
    emailIds.map(async (emailId) => {
      await operation(emailId);
      return emailId;
    })
  );
  const succeeded = results
    .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
    .map((r) => r.value);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length > 0) {
    logger.warn(`${toolName}: ${failed.length}/${emailIds.length} operations failed`, "MCPServer", {
      ...logContext,
      errors: failed.map((f) => f.reason?.message ?? String(f.reason)),
    });
  }
  return { succeeded, failedCount: failed.length };
};

const notImplemented = (toolName: string) => {
  throw new McpError(ErrorCode.MethodNotFound, `Tool ${toolName} is not implemented yet`);
};

const createServer = () => {
  const server = new Server(
    {
      name: "email-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug("Listing available tools", "MCPServer");

    return {
      tools: toolDefinitions,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = getArguments(request.params.arguments);
    const folder = typeof args.folder === "string" && args.folder.trim() ? args.folder.trim() : "INBOX";
    if ("folder" in args && (typeof args.folder !== "string" || !args.folder.trim())) {
      throw new McpError(ErrorCode.InvalidParams, `${toolName} requires folder to be a non-empty string`);
    }
    try {
      switch (toolName) {
        case "send_email": {
          assertNoUnknownKeys(
            args,
            [
              "to",
              "cc",
              "bcc",
              "subject",
              "body",
              "template",
              "templateData",
              "isHtml",
              "priority",
              "replyTo",
              "requestReadReceipt",
              "scheduleAt",
              "scheduleDelayMinutes",
              "attachments",
            ],
            "send_email"
          );
          const to = requireString(args, "to", "send_email");
          const subject = requireString(args, "subject", "send_email");
          const body = optionalString(args, "body", "send_email");
          const template = optionalString(args, "template", "send_email");
          if (!body && !template) {
            throw new McpError(ErrorCode.InvalidParams, "send_email requires body or template");
          }

          const recipients = parseEmails(to);
          if (recipients.length === 0 || recipients.some((email) => !isValidEmail(email))) {
            throw new McpError(ErrorCode.InvalidParams, "send_email requires valid recipient email addresses");
          }

          const templateDataRaw = args.templateData;
          if (
            templateDataRaw !== undefined
            && (typeof templateDataRaw !== "object" || templateDataRaw === null || Array.isArray(templateDataRaw))
          ) {
            throw new McpError(ErrorCode.InvalidParams, "send_email templateData must be an object");
          }

          const payload = {
            to,
            cc: optionalString(args, "cc", "send_email"),
            bcc: optionalString(args, "bcc", "send_email"),
            subject,
            body,
            template,
            templateData: templateDataRaw
              ? (templateDataRaw as Record<string, string | number | boolean>)
              : undefined,
            isHtml: optionalBoolean(args, "isHtml", "send_email"),
            priority: optionalString(args, "priority", "send_email") as "high" | "normal" | "low" | undefined,
            replyTo: optionalString(args, "replyTo", "send_email"),
            requestReadReceipt: optionalBoolean(args, "requestReadReceipt", "send_email"),
            attachments: Array.isArray(args.attachments)
              ? (args.attachments as Array<{
                filename: string;
                content: string;
                encoding?: string;
                contentType?: string;
              }>)
              : undefined,
          };
          if (payload.priority && !["high", "normal", "low"].includes(payload.priority)) {
            throw new McpError(ErrorCode.InvalidParams, "send_email priority must be one of high, normal, low");
          }

          if (payload.attachments) {
            payload.attachments.forEach((attachment, index) => {
              if (!attachment || typeof attachment !== "object") {
                throw new McpError(ErrorCode.InvalidParams, `send_email attachments[${index}] must be an object`);
              }
              if (typeof attachment.filename !== "string" || typeof attachment.content !== "string") {
                throw new McpError(ErrorCode.InvalidParams, `send_email attachments[${index}] requires filename and content strings`);
              }
              if (attachment.encoding && typeof attachment.encoding !== "string") {
                throw new McpError(ErrorCode.InvalidParams, `send_email attachments[${index}].encoding must be a string`);
              }
              if (attachment.contentType && typeof attachment.contentType !== "string") {
                throw new McpError(ErrorCode.InvalidParams, `send_email attachments[${index}].contentType must be a string`);
              }
            });
          }

          const scheduleAt = optionalString(args, "scheduleAt", "send_email");
          const scheduleDelayMinutes = optionalNumber(args, "scheduleDelayMinutes", "send_email");
          if (scheduleDelayMinutes !== undefined && scheduleDelayMinutes < 0) {
            throw new McpError(ErrorCode.InvalidParams, "send_email scheduleDelayMinutes must be 0 or greater");
          }
          if (scheduleAt || scheduleDelayMinutes) {
            const targetDate = scheduleAt
              ? parseDateInput(scheduleAt, "scheduleAt", "send_email")
              : new Date(Date.now() + Math.max(0, scheduleDelayMinutes ?? 0) * 60_000);
            const scheduled = smtpService.scheduleEmail(payload, targetDate);
            return {
              content: [{ type: "text", text: JSON.stringify({ scheduled: true, ...scheduled }) }],
            };
          }

          await smtpService.sendEmail(payload);
          analyticsService.recordSentEmail();

          return {
            content: [{ type: "text", text: `Email sent to ${recipients.join(", ")}` }],
          };
        }
        case "send_test_email": {
          assertNoUnknownKeys(args, ["to", "customMessage"], "send_test_email");
          const to = requireString(args, "to", "send_test_email");
          if (!isValidEmail(to)) {
            throw new McpError(ErrorCode.InvalidParams, "send_test_email requires a valid to email address");
          }
          const message = optionalString(args, "customMessage", "send_test_email");
          await smtpService.sendTestEmail(to, message);
          analyticsService.recordSentEmail();
          return {
            content: [{ type: "text", text: `Test email sent to ${to}` }],
          };
        }
        case "get_email_analytics": {
          assertNoUnknownKeys(args, ["folder"], "get_email_analytics");
          const snapshot = analyticsService.getSnapshot();
          const mailboxStatus = await imapService.getMailboxStatus(folder);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...snapshot,
                  mailbox: mailboxStatus,
                }),
              },
            ],
          };
        }
        case "get_emails": {
          assertNoUnknownKeys(args, ["folder", "limit", "offset"], "get_emails");
          const limit = optionalNumber(args, "limit", "get_emails") ?? 50;
          const offset = optionalNumber(args, "offset", "get_emails") ?? 0;
          if (limit < 1 || limit > 200) {
            throw new McpError(ErrorCode.InvalidParams, "get_emails limit must be between 1 and 200");
          }
          if (offset < 0) {
            throw new McpError(ErrorCode.InvalidParams, "get_emails offset must be 0 or greater");
          }
          const result = await imapService.getEmails(folder, limit, offset);
          if (result.emails.length > 0) {
            analyticsService.recordReceivedEmail();
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result),
              },
            ],
          };
        }
        case "get_email_by_id": {
          assertNoUnknownKeys(args, ["folder", "emailId"], "get_email_by_id");
          const emailIdRaw = requireString(args, "emailId", "get_email_by_id");
          const emailId = Number(emailIdRaw);
          if (!Number.isFinite(emailId)) {
            throw new McpError(ErrorCode.InvalidParams, "get_email_by_id requires numeric emailId");
          }
          const email = await imapService.getEmailById(folder, emailId);
          if (!email) {
            throw new McpError(ErrorCode.InvalidParams, `Email ${emailId} not found in ${folder}`);
          }
          analyticsService.recordReceivedEmail();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(email),
              },
            ],
          };
        }
        case "search_emails": {
          assertNoUnknownKeys(
            args,
            ["query", "folder", "from", "to", "subject", "hasAttachment", "isRead", "isStarred", "dateFrom", "dateTo", "limit"],
            "search_emails"
          );
          const limit = optionalNumber(args, "limit", "search_emails") ?? 100;
          if (limit < 1 || limit > 500) {
            throw new McpError(ErrorCode.InvalidParams, "search_emails limit must be between 1 and 500");
          }
          if (args.hasAttachment !== undefined) {
            throw new McpError(ErrorCode.InvalidParams, "search_emails hasAttachment is not supported yet");
          }
          const { since, before } = normalizeDateRange(
            optionalString(args, "dateFrom", "search_emails"),
            optionalString(args, "dateTo", "search_emails"),
            "search_emails"
          );
          const result = await imapService.searchEmails(folder, {
            query: optionalString(args, "query", "search_emails"),
            from: optionalString(args, "from", "search_emails"),
            to: optionalString(args, "to", "search_emails"),
            subject: optionalString(args, "subject", "search_emails"),
            isRead: optionalBoolean(args, "isRead", "search_emails"),
            isStarred: optionalBoolean(args, "isStarred", "search_emails"),
            dateFrom: since,
            dateTo: before,
            limit,
          });
          if (result.emails.length > 0) {
            analyticsService.recordReceivedEmail();
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result),
              },
            ],
          };
        }
        case "get_thread": {
          assertNoUnknownKeys(args, ["folder", "threadId", "limit"], "get_thread");
          const threadId = requireString(args, "threadId", "get_thread");
          const limit = optionalNumber(args, "limit", "get_thread") ?? 200;
          if (limit < 1 || limit > 500) {
            throw new McpError(ErrorCode.InvalidParams, "get_thread limit must be between 1 and 500");
          }
          const result = await imapService.getThread(folder, threadId, limit);
          if (result.emails.length > 0) {
            analyticsService.recordReceivedEmail();
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result),
              },
            ],
          };
        }
        case "get_folders": {
          assertNoUnknownKeys(args, [], "get_folders");
          const folders = await imapService.listFolders();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(folders),
              },
            ],
          };
        }
        case "mark_email_read": {
          assertNoUnknownKeys(args, ["folder", "emailIds", "isRead"], "mark_email_read");
          const emailIds = parseEmailIds(args, "mark_email_read");
          const isRead = optionalBoolean(args, "isRead", "mark_email_read") ?? true;
          const { succeeded, failedCount } = await runBatchEmailOperation(
            emailIds,
            (emailId) => imapService.setEmailRead(folder, emailId, isRead),
            "mark_email_read",
            { folder }
          );
          imapService.invalidateFolderCache(folder);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ emailIds: succeeded, isRead, failedCount }),
              },
            ],
          };
        }
        case "star_email": {
          assertNoUnknownKeys(args, ["folder", "emailIds", "isStarred"], "star_email");
          const emailIds = parseEmailIds(args, "star_email");
          const isStarred = optionalBoolean(args, "isStarred", "star_email") ?? true;
          const { succeeded, failedCount } = await runBatchEmailOperation(
            emailIds,
            (emailId) => imapService.setEmailStarred(folder, emailId, isStarred),
            "star_email",
            { folder }
          );
          imapService.invalidateFolderCache(folder);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ emailIds: succeeded, isStarred, failedCount }),
              },
            ],
          };
        }
        case "move_email": {
          assertNoUnknownKeys(args, ["folder", "emailIds", "targetFolder"], "move_email");
          const targetFolder = requireString(args, "targetFolder", "move_email");
          const emailIds = parseEmailIds(args, "move_email");
          const { succeeded, failedCount } = await runBatchEmailOperation(
            emailIds,
            (emailId) => imapService.moveEmail(folder, emailId, targetFolder),
            "move_email",
            { folder, targetFolder }
          );
          imapService.invalidateFolderCache(folder);
          imapService.invalidateFolderCache(targetFolder);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ emailIds: succeeded, targetFolder, failedCount }),
              },
            ],
          };
        }
        case "delete_email": {
          assertNoUnknownKeys(args, ["folder", "emailIds"], "delete_email");
          const emailIds = parseEmailIds(args, "delete_email");
          const { succeeded, failedCount } = await runBatchEmailOperation(
            emailIds,
            (emailId) => imapService.deleteEmail(folder, emailId),
            "delete_email",
            { folder }
          );
          imapService.invalidateFolderCache(folder);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ emailIds: succeeded, deleted: true, failedCount }),
              },
            ],
          };
        }
        case "get_contacts": {
          assertNoUnknownKeys(args, ["folder", "limit"], "get_contacts");
          const limit = optionalNumber(args, "limit", "get_contacts") ?? 100;
          if (limit < 1 || limit > 500) {
            throw new McpError(ErrorCode.InvalidParams, "get_contacts limit must be between 1 and 500");
          }
          const contacts = await imapService.getContacts(folder, limit);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(contacts),
              },
            ],
          };
        }
        case "get_volume_trends": {
          assertNoUnknownKeys(args, ["folder", "days"], "get_volume_trends");
          const days = optionalNumber(args, "days", "get_volume_trends") ?? 30;
          if (days < 1 || days > 365) {
            throw new McpError(ErrorCode.InvalidParams, "get_volume_trends days must be between 1 and 365");
          }
          const trends = await imapService.getVolumeTrends(folder, days);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(trends),
              },
            ],
          };
        }
        default:
          return notImplemented(toolName);
      }
    } catch (error) {
      const { mcpError, retryable, message, code } = mapServiceError(error);
      logger.debug("Tool execution failed", "MCPServer", {
        tool: toolName,
        arguments: args,
        message,
        code,
      });

      if (error instanceof McpError) {
        throw error;
      }
      if (mcpError) {
        throw mcpError;
      }

      // Throw a proper MCP error instead of returning an error response object
      // This ensures the MCP protocol correctly signals the error to clients
      throw new McpError(
        retryable ? ErrorCode.InternalError : ErrorCode.InvalidRequest,
        `${toolName}: ${message}${code ? ` (${code})` : ""}`
      );
    }
  });

  return server;
};

/**
 * Main server startup function
 */
async function main() {
  logger.info("🌟 Starting MCP Email Server (SSE)...", "MCPServer");

  try {
    // Verify SMTP connection
    logger.info("🔗 Verifying SMTP connection...", "MCPServer");
    const smtpReady = await verifySmtpWithRetry(CONNECTION_RETRY_MAX_ATTEMPTS);
    if (smtpReady) {
      logger.info("✅ SMTP connection verified", "MCPServer");
    } else {
      logger.warn("⚠️ SMTP verification failed - email sending features will be limited", "MCPServer");
      logger.info("💡 Verify your SMTP host/port credentials and connectivity", "MCPServer");
    }

    // Try to connect to IMAP with retry
    logger.info("🔗 Connecting to IMAP...", "MCPServer");
    const imapReady = await connectImapWithRetry(CONNECTION_RETRY_MAX_ATTEMPTS);
    if (imapReady) {
      logger.info("✅ IMAP connection established", "MCPServer");
    } else {
      logger.warn("⚠️ IMAP connection failed - email reading features will be limited", "MCPServer");
      logger.info("💡 Verify your IMAP host/port credentials and connectivity", "MCPServer");
    }

    if (config.autoSync) {
      const intervalMs = Math.max(1, config.syncIntervalSeconds) * 1000;
      imapService.startRealtimeSync("INBOX", intervalMs, (status) => {
        logger.info("📡 Realtime sync update detected", "MCPServer", status);
      });
      logger.info(`🕒 Realtime sync polling enabled for INBOX every ${config.syncIntervalSeconds} seconds`, "MCPServer");
    }

    const app = createMcpExpressApp({
      host: MCP_HOST,
      allowedHosts: MCP_ALLOWED_HOSTS,
    });

    const transports = new Map<string, SSEServerTransport>();

    app.get("/sse", async (req, res) => {
      if (!requireToken(req, res)) {
        return;
      }

      logger.info("📡 SSE client connected", "MCPServer", {
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      try {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        logger.debug("✅ SSE session established", "MCPServer", {
          sessionId: transport.sessionId,
        });

        transport.onclose = () => {
          transports.delete(transport.sessionId);
          logger.info("📴 SSE session closed", "MCPServer", {
            sessionId: transport.sessionId,
          });
        };

        const server = createServer();
        await withTimeout("SSE server connection", server.connect(transport), SSE_CONNECTION_TIMEOUT_MS);
      } catch (error) {
        logger.error("❌ Failed to establish SSE session", "MCPServer", error);
        res.status(500).send("Failed to establish SSE session");
      }
    });

    app.post("/messages", async (req, res) => {
      if (!requireToken(req, res)) {
        return;
      }

      const sessionId = Array.isArray(req.query.sessionId)
        ? req.query.sessionId[0]
        : req.query.sessionId;

      if (!sessionId || typeof sessionId !== "string") {
        res.status(400).send("Missing sessionId query parameter");
        return;
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        logger.warn("Received MCP message for unknown session", "MCPServer", {
          sessionId,
          ip: req.ip,
        });
        res.status(404).send("Unknown sessionId");
        return;
      }

      logger.debug("📨 MCP message received", "MCPServer", {
        sessionId,
        contentLength: req.get("content-length"),
      });
      try {
        await transport.handlePostMessage(req, res, req.body);
      } catch (error) {
        logger.error("❌ Failed to handle MCP message", "MCPServer", {
          sessionId,
          error,
        });
        res.status(500).send("Failed to handle MCP message");
      }
    });

    const activeSockets = new Set<import("net").Socket>();
    const httpServer = app.listen(MCP_PORT, MCP_HOST, () => {
      logger.info(`🚀 MCP SSE server listening on http://${MCP_HOST}:${MCP_PORT}`, "MCPServer");
      logger.info("🌟 Connect via /sse and POST messages to /messages", "MCPServer");
    });

    httpServer.on("connection", (socket) => {
      activeSockets.add(socket);
      socket.on("close", () => {
        activeSockets.delete(socket);
      });
    });

    httpServer.on("error", (error) => {
      logger.error("❌ HTTP server error", "MCPServer", error);
      process.exit(1);
    });

    const shutdown = async () => {
      logger.info("📡 Received shutdown signal, closing server...", "MCPServer");
      const shutdownTimeoutMs = 10_000;
      const closeTransports = Promise.all(
        Array.from(transports.values()).map((transport) => transport.close()),
      );
      try {
        await withTimeout("Transport shutdown", closeTransports, shutdownTimeoutMs);
      } catch (error) {
        logger.warn("⚠️ Transport shutdown timed out", "MCPServer", error);
      }
      transports.clear();
      imapService.stopRealtimeSync("INBOX");
      try {
        await withTimeout("IMAP disconnect", imapService.disconnect(), shutdownTimeoutMs);
      } catch (error) {
        logger.warn("⚠️ IMAP disconnect timed out", "MCPServer", error);
      }
      try {
        await withTimeout("SMTP shutdown", smtpService.close(), shutdownTimeoutMs);
      } catch (error) {
        logger.warn("⚠️ SMTP shutdown timed out", "MCPServer", error);
      }

      const closeServer = new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
      });

      try {
        await withTimeout("HTTP server shutdown", closeServer, shutdownTimeoutMs);
      } catch (error) {
        logger.warn("⚠️ HTTP server shutdown timed out; destroying sockets", "MCPServer", error);
        for (const socket of activeSockets) {
          socket.destroy();
        }
      }

      logger.info("👋 Server shutdown complete", "MCPServer");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    logger.error("❌ Server startup failed", "MCPServer", error);
    process.exit(1);
  }
}

// Error handling
process.on("uncaughtException", (error) => {
  logger.error("💥 Uncaught exception", "MCPServer", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("💥 Unhandled rejection", "MCPServer", reason);
  process.exit(1);
});

// Start the server
main().catch((error) => {
  logger.error("💥 Fatal server error", "MCPServer", error);
  process.exit(1);
});
