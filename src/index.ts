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

const requireToken = (req: Request, res: Response): boolean => {
  if (!MCP_TOKEN) {
    return true;
  }

  const token = getTokenFromRequest(req);
  if (token && token === MCP_TOKEN) {
    return true;
  }

  logger.warn("Unauthorized MCP request rejected", "MCPServer");
  res.status(401).send("Unauthorized");
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
  {
    name: "sync_folders",
    description: "🔄 Synchronize folder structure from server",
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
    name: "get_email_stats",
    description: "📊 Get comprehensive email statistics",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_email_analytics",
    description: "📈 Get advanced email analytics and insights",
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

  // 🔧 SYSTEM & MAINTENANCE TOOLS
  {
    name: "get_connection_status",
    description: "🔌 Check SMTP and IMAP connection status",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "sync_emails",
    description: "🔄 Manually sync emails from server",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder to sync (default: all)" },
        full: { type: "boolean", description: "Full sync vs incremental", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "clear_cache",
    description: "🧹 Clear email cache and analytics cache",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_logs",
    description: "📋 Get recent system logs",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["debug", "info", "warn", "error"], description: "Log level filter" },
        limit: { type: "number", description: "Max log entries", default: 100 }
      },
      additionalProperties: false
    }
  }
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
        case "get_connection_status": {
          assertNoUnknownKeys(args, [], "get_connection_status");
          let smtpOk = true;
          try {
            await smtpService.verifyConnection();
          } catch (error) {
            logger.warn("SMTP connection check failed", "MCPServer", error);
            smtpOk = false;
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  smtp: smtpOk,
                  imap: imapService.isConnected(),
                }),
              },
            ],
          };
        }
        case "get_email_stats": {
          assertNoUnknownKeys(args, [], "get_email_stats");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(analyticsService.getSnapshot()),
              },
            ],
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
        case "sync_folders": {
          assertNoUnknownKeys(args, [], "sync_folders");
          const folders = await imapService.listFolders();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  synced: true,
                  folders,
                }),
              },
            ],
          };
        }
        case "mark_email_read": {
          assertNoUnknownKeys(args, ["folder", "emailIds", "isRead"], "mark_email_read");
          const emailIds = parseEmailIds(args, "mark_email_read");
          const isRead = optionalBoolean(args, "isRead", "mark_email_read") ?? true;
          await Promise.all(
            emailIds.map(async (emailId) => {
              await imapService.setEmailRead(folder, emailId, isRead);
            })
          );
          imapService.invalidateFolderCache(folder);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ emailIds, isRead }),
              },
            ],
          };
        }
        case "star_email": {
          assertNoUnknownKeys(args, ["folder", "emailIds", "isStarred"], "star_email");
          const emailIds = parseEmailIds(args, "star_email");
          const isStarred = optionalBoolean(args, "isStarred", "star_email") ?? true;
          await Promise.all(
            emailIds.map(async (emailId) => {
              await imapService.setEmailStarred(folder, emailId, isStarred);
            })
          );
          imapService.invalidateFolderCache(folder);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ emailIds, isStarred }),
              },
            ],
          };
        }
        case "move_email": {
          assertNoUnknownKeys(args, ["folder", "emailIds", "targetFolder"], "move_email");
          const targetFolder = requireString(args, "targetFolder", "move_email");
          const emailIds = parseEmailIds(args, "move_email");
          await Promise.all(
            emailIds.map(async (emailId) => {
              await imapService.moveEmail(folder, emailId, targetFolder);
            })
          );
          imapService.invalidateFolderCache(folder);
          imapService.invalidateFolderCache(targetFolder);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ emailIds, targetFolder }),
              },
            ],
          };
        }
        case "delete_email": {
          assertNoUnknownKeys(args, ["folder", "emailIds"], "delete_email");
          const emailIds = parseEmailIds(args, "delete_email");
          await Promise.all(
            emailIds.map(async (emailId) => {
              await imapService.deleteEmail(folder, emailId);
            })
          );
          imapService.invalidateFolderCache(folder);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ emailIds, deleted: true }),
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
        case "sync_emails": {
          assertNoUnknownKeys(args, ["folder", "full"], "sync_emails");
          if (args.full !== undefined) {
            optionalBoolean(args, "full", "sync_emails");
          }
          const status = await imapService.getMailboxStatus(folder);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  synced: true,
                  status,
                }),
              },
            ],
          };
        }
        case "clear_cache": {
          assertNoUnknownKeys(args, [], "clear_cache");
          analyticsService.clear();
          imapService.clearCache();
          const clearedScheduled = smtpService.clearScheduledEmails();
          return {
            content: [{ type: "text", text: JSON.stringify({ analyticsCleared: true, imapCacheCleared: true, scheduledEmailsCleared: clearedScheduled }) }],
          };
        }
        case "get_logs": {
          assertNoUnknownKeys(args, ["level", "limit"], "get_logs");
          const level = optionalString(args, "level", "get_logs") as "debug" | "info" | "warn" | "error" | undefined;
          if (level && !["debug", "info", "warn", "error"].includes(level)) {
            throw new McpError(ErrorCode.InvalidParams, "get_logs level must be one of debug, info, warn, error");
          }
          const limit = optionalNumber(args, "limit", "get_logs") ?? 100;
          if (limit < 1 || limit > 500) {
            throw new McpError(ErrorCode.InvalidParams, "get_logs limit must be between 1 and 500");
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(logger.getLogs(level, limit)),
              },
            ],
          };
        }
        default:
          return notImplemented(toolName);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug("Tool execution failed", "MCPServer", {
        tool: toolName,
        arguments: args,
        message,
      });

      if (error instanceof McpError) {
        throw error;
      }

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "error", tool: toolName, message }),
          },
        ],
      };
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
    await smtpService.verifyConnection();
    logger.info("✅ SMTP connection verified", "MCPServer");

    // Try to connect to IMAP
    logger.info("🔗 Connecting to IMAP...", "MCPServer");
    try {
      await imapService.connect();
      logger.info("✅ IMAP connection established", "MCPServer");
    } catch (imapError) {
      logger.warn("⚠️ IMAP connection failed - email reading features will be limited", "MCPServer", imapError);
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

      logger.info("📡 SSE client connected", "MCPServer");
      try {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);

        transport.onclose = () => {
          transports.delete(transport.sessionId);
          logger.info(`📴 SSE session closed: ${transport.sessionId}`, "MCPServer");
        };

        const server = createServer();
        await server.connect(transport);
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
        res.status(404).send("Unknown sessionId");
        return;
      }

      await transport.handlePostMessage(req, res, req.body);
    });

    const httpServer = app.listen(MCP_PORT, MCP_HOST, () => {
      logger.info(`🚀 MCP SSE server listening on http://${MCP_HOST}:${MCP_PORT}`, "MCPServer");
      logger.info("🌟 Connect via /sse and POST messages to /messages", "MCPServer");
    });

    httpServer.on("error", (error) => {
      logger.error("❌ HTTP server error", "MCPServer", error);
      process.exit(1);
    });

    const shutdown = async () => {
      logger.info("📡 Received shutdown signal, closing server...", "MCPServer");
      for (const transport of transports.values()) {
        await transport.close();
      }
      transports.clear();
      imapService.stopRealtimeSync("INBOX");
      await imapService.disconnect();
      await smtpService.close();
      httpServer.close(() => {
        logger.info("👋 Server shutdown complete", "MCPServer");
        process.exit(0);
      });
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
