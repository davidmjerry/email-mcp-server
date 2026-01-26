import nodemailer, { Transporter } from "nodemailer";
import { MailConfig } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { parseEmails, renderTemplate } from "../utils/helpers.js";

export interface SendEmailOptions {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body?: string;
  isHtml?: boolean;
  priority?: "high" | "normal" | "low";
  replyTo?: string;
  template?: string;
  templateData?: Record<string, string | number | boolean>;
  requestReadReceipt?: boolean;
  attachments?: Array<{
    filename: string;
    content: string;
    encoding?: string;
    contentType?: string;
  }>;
}

export class SMTPService {
  private transporter: Transporter;
  private readonly config: MailConfig;
  private scheduledJobs = new Map<string, NodeJS.Timeout>();

  constructor(config: MailConfig) {
    this.config = config;
    this.transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      tls: {
        rejectUnauthorized: config.smtp.rejectUnauthorized,
      },
      auth: {
        user: config.smtp.username,
        pass: config.smtp.password,
      },
    });
  }

  async verifyConnection(): Promise<void> {
    await this.transporter.verify();
  }

  private buildBody(options: SendEmailOptions): { body: string; isHtml: boolean } {
    const templateData = options.templateData ?? {};
    if (options.template) {
      return {
        body: renderTemplate(options.template, templateData),
        isHtml: options.isHtml ?? true,
      };
    }
    if (!options.body) {
      throw new Error("Email body is required when no template is provided");
    }
    return {
      body: options.body,
      isHtml: options.isHtml ?? false,
    };
  }

  async sendEmail(options: SendEmailOptions): Promise<void> {
    const to = parseEmails(options.to);
    const cc = parseEmails(options.cc);
    const bcc = parseEmails(options.bcc);

    if (to.length === 0) {
      throw new Error("At least one recipient is required");
    }

    const resolvedBody = this.buildBody(options);
    const attachments = options.attachments?.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      encoding: attachment.encoding ?? "base64",
      contentType: attachment.contentType,
    }));

    const headers: Record<string, string> = {};
    if (options.requestReadReceipt) {
      const receiptTarget = options.replyTo ?? this.config.smtp.username;
      headers["Disposition-Notification-To"] = receiptTarget;
      headers["Return-Receipt-To"] = receiptTarget;
    }

    await this.transporter.sendMail({
      from: this.config.smtp.username,
      to,
      cc: cc.length > 0 ? cc : undefined,
      bcc: bcc.length > 0 ? bcc : undefined,
      subject: options.subject,
      text: resolvedBody.isHtml ? undefined : resolvedBody.body,
      html: resolvedBody.isHtml ? resolvedBody.body : undefined,
      priority: options.priority,
      replyTo: options.replyTo,
      headers,
      attachments,
    });

    logger.info("✅ Email sent", "SMTPService", { to, subject: options.subject });
  }

  async sendTestEmail(to: string, message?: string): Promise<void> {
    await this.sendEmail({
      to,
      subject: "MCP Test Email",
      body: message ?? "Your SMTP configuration is working!",
    });
  }

  scheduleEmail(options: SendEmailOptions, scheduleAt: Date): { jobId: string; scheduledAt: string } {
    const delayMs = Math.max(0, scheduleAt.getTime() - Date.now());
    const jobId = `job_${Math.random().toString(36).slice(2, 10)}`;

    const timeout = setTimeout(async () => {
      try {
        await this.sendEmail(options);
      } catch (error) {
        logger.error("❌ Scheduled email send failed", "SMTPService", { jobId, error });
      } finally {
        this.scheduledJobs.delete(jobId);
      }
    }, delayMs);

    this.scheduledJobs.set(jobId, timeout);

    return { jobId, scheduledAt: scheduleAt.toISOString() };
  }

  clearScheduledEmails(): number {
    const jobs = Array.from(this.scheduledJobs.values());
    for (const job of jobs) {
      clearTimeout(job);
    }
    const count = jobs.length;
    this.scheduledJobs.clear();
    return count;
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}
