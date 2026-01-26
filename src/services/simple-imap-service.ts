import { ImapFlow, ImapFlowOptions, MessageEnvelopeObject, MessageAddressObject, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { MailConfig } from "../types/index.js";
import { logger } from "../utils/logger.js";

export interface EmailAddressSummary {
  name?: string;
  address?: string;
}

export interface EmailSummary {
  id: number;
  subject?: string;
  from?: EmailAddressSummary[];
  to?: EmailAddressSummary[];
  date?: string;
  flags?: string[];
  size?: number;
  messageId?: string;
  threadId?: string;
  references?: string[];
}

export interface EmailDetail extends EmailSummary {
  text?: string;
  html?: string | false;
  attachments?: Array<{
    filename?: string;
    contentType?: string;
    size?: number;
  }>;
}

export interface FolderSummary {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  totalMessages?: number;
  unseenMessages?: number;
}

export interface MailboxStatusSummary {
  folder: string;
  totalMessages?: number;
  unseenMessages?: number;
  uidNext?: number;
  uidValidity?: number;
}

export class SimpleIMAPService {
  private client: ImapFlow | null = null;
  private config: MailConfig | null = null;
  private folderCache: FolderSummary[] | null = null;
  private mailboxStatusCache = new Map<string, MailboxStatusSummary>();
  private emailsCache = new Map<string, { folder: string; total: number; emails: EmailSummary[] }>();
  private emailByIdCache = new Map<string, EmailDetail | null>();
  private realtimeSyncTimers = new Map<string, NodeJS.Timeout>();
  private realtimeSyncInFlight = new Set<string>();

  constructor(config?: MailConfig) {
    if (config) {
      this.config = config;
    }
  }

  setConfig(config: MailConfig) {
    this.config = config;
  }

  private isCacheEnabled(): boolean {
    return Boolean(this.config?.cacheEnabled);
  }

  async connect(): Promise<void> {
    if (!this.config) {
      throw new Error("IMAP configuration is not set");
    }

    if (this.client?.authenticated) {
      return;
    }

    const options: ImapFlowOptions = {
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      tls: {
        rejectUnauthorized: this.config.imap.rejectUnauthorized,
      },
      auth: {
        user: this.config.imap.username,
        pass: this.config.imap.password,
      },
    };

    this.client = new ImapFlow(options);
    await this.client.connect();
    logger.info("✅ IMAP connection established", "SimpleIMAPService");
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.logout();
    } finally {
      this.client = null;
    }
  }

  isConnected(): boolean {
    return Boolean(this.client?.authenticated);
  }

  private async getClient(): Promise<ImapFlow> {
    if (!this.config) {
      throw new Error("IMAP configuration is not set");
    }

    if (!this.client || !this.client.authenticated) {
      await this.connect();
    }

    if (!this.client) {
      throw new Error("IMAP client is not initialized");
    }

    return this.client;
  }

  private toAddressList(addresses?: MessageAddressObject[]): EmailAddressSummary[] | undefined {
    if (!addresses) {
      return undefined;
    }
    return addresses.map((address) => ({
      name: address.name,
      address: address.address,
    }));
  }

  private envelopeToSummary(
    envelope?: MessageEnvelopeObject,
  ): Pick<EmailSummary, "subject" | "from" | "to" | "date" | "messageId" | "references" | "threadId"> {
    if (!envelope) {
      return {};
    }

    const references = Array.isArray((envelope as { references?: string[] }).references)
      ? (envelope as { references?: string[] }).references
      : undefined;
    const inReplyTo = Array.isArray((envelope as { inReplyTo?: string[] }).inReplyTo)
      ? (envelope as { inReplyTo?: string[] }).inReplyTo
      : undefined;
    const threadId = references?.[0] ?? inReplyTo?.[0] ?? envelope.messageId;

    return {
      subject: envelope.subject,
      from: this.toAddressList(envelope.from),
      to: this.toAddressList(envelope.to),
      date: envelope.date ? envelope.date.toISOString() : undefined,
      messageId: envelope.messageId,
      references,
      threadId,
    };
  }

  private async withMailbox<T>(path: string, handler: () => Promise<T>): Promise<T> {
    const client = await this.getClient();
    const lock = await client.getMailboxLock(path);
    try {
      return await handler();
    } finally {
      lock.release();
    }
  }

  private invalidateFolderCaches(folder: string): void {
    if (!this.isCacheEnabled()) {
      return;
    }
    this.folderCache = null;
    this.mailboxStatusCache.delete(folder);
    for (const key of this.emailsCache.keys()) {
      if (key.startsWith(`${folder}:`)) {
        this.emailsCache.delete(key);
      }
    }
    for (const key of this.emailByIdCache.keys()) {
      if (key.startsWith(`${folder}:`)) {
        this.emailByIdCache.delete(key);
      }
    }
  }

  private invalidateEmailCache(folder: string, emailId: number): void {
    if (!this.isCacheEnabled()) {
      return;
    }
    this.emailByIdCache.delete(`${folder}:${emailId}`);
  }

  async listFolders(): Promise<FolderSummary[]> {
    if (this.isCacheEnabled() && this.folderCache) {
      return this.folderCache;
    }
    const client = await this.getClient();
    const folders = await client.list({
      statusQuery: {
        messages: true,
        unseen: true,
      },
    });

    const mapped = folders.map((folder) => ({
      path: folder.path,
      name: folder.name,
      delimiter: folder.delimiter,
      flags: Array.from(folder.flags ?? []),
      specialUse: folder.specialUse,
      totalMessages: folder.status?.messages,
      unseenMessages: folder.status?.unseen,
    }));
    if (this.isCacheEnabled()) {
      this.folderCache = mapped;
    }
    return mapped;
  }

  async getMailboxStatus(folder: string): Promise<MailboxStatusSummary> {
    if (this.isCacheEnabled() && this.mailboxStatusCache.has(folder)) {
      return this.mailboxStatusCache.get(folder) as MailboxStatusSummary;
    }
    const client = await this.getClient();
    const status = await client.status(folder, {
      messages: true,
      unseen: true,
      uidNext: true,
      uidValidity: true,
    });

    const summary = {
      folder,
      totalMessages: status.messages,
      unseenMessages: status.unseen,
      uidNext: status.uidNext,
      uidValidity: typeof status.uidValidity === "bigint" ? Number(status.uidValidity) : status.uidValidity,
    };
    if (this.isCacheEnabled()) {
      this.mailboxStatusCache.set(folder, summary);
    }
    return summary;
  }

  private async fetchEmailsFromServer(
    folder: string,
    limit: number,
    offset: number,
  ): Promise<{ folder: string; total: number; emails: EmailSummary[] }> {
    return this.withMailbox(folder, async () => {
      const client = await this.getClient();
      const mailbox = client.mailbox;

      if (!mailbox) {
        throw new Error(`Mailbox ${folder} is not available`);
      }

      const total = mailbox.exists ?? 0;
      if (total === 0) {
        return { folder, total: 0, emails: [] };
      }

      const safeLimit = Math.max(1, Math.min(limit, total));
      const safeOffset = Math.max(0, offset);
      if (safeOffset >= total) {
        return { folder, total, emails: [] };
      }
      const end = Math.max(1, total - safeOffset);
      const start = Math.max(1, end - safeLimit + 1);

      const emails: EmailSummary[] = [];
      for await (const message of client.fetch(`${start}:${end}`, {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        size: true,
      })) {
        emails.push({
          id: message.uid ?? message.seq,
          ...this.envelopeToSummary(message.envelope),
          flags: Array.from(message.flags ?? []),
          size: message.size,
        });
      }

      emails.sort((a, b) => {
        if (!a.date || !b.date) {
          return 0;
        }
        return b.date.localeCompare(a.date);
      });

      const result = { folder, total, emails };
      return result;
    });
  }

  async getEmails(folder: string, limit: number, offset: number): Promise<{ folder: string; total: number; emails: EmailSummary[] }> {
    const cacheKey = `${folder}:${limit}:${offset}`;
    if (this.isCacheEnabled() && this.emailsCache.has(cacheKey)) {
      return this.emailsCache.get(cacheKey) as { folder: string; total: number; emails: EmailSummary[] };
    }
    const result = await this.fetchEmailsFromServer(folder, limit, offset);
    if (this.isCacheEnabled()) {
      this.emailsCache.set(cacheKey, result);
    }
    return result;
  }

  invalidateFolderCache(folder: string): void {
    this.invalidateFolderCaches(folder);
  }

  async getEmailById(folder: string, emailId: number): Promise<EmailDetail | null> {
    const cacheKey = `${folder}:${emailId}`;
    if (this.isCacheEnabled() && this.emailByIdCache.has(cacheKey)) {
      return this.emailByIdCache.get(cacheKey) as EmailDetail | null;
    }
    return this.withMailbox(folder, async () => {
      const client = await this.getClient();
      for await (const message of client.fetch(String(emailId), {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        size: true,
        source: true,
      }, { uid: true })) {
        const parsed = message.source ? await simpleParser(message.source) : null;
        const detail = {
          id: message.uid ?? message.seq,
          ...this.envelopeToSummary(message.envelope),
          flags: Array.from(message.flags ?? []),
          size: message.size,
          text: parsed?.text ?? undefined,
          html: parsed?.html ?? undefined,
          attachments: parsed?.attachments?.map((attachment: { filename?: string; contentType?: string; size?: number }) => ({
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
          })) ?? undefined,
        };
        if (this.isCacheEnabled()) {
          this.emailByIdCache.set(cacheKey, detail);
        }
        return detail;
      }

      if (this.isCacheEnabled()) {
        this.emailByIdCache.set(cacheKey, null);
      }
      return null;
    });
  }

  async searchEmails(folder: string, search: {
    query?: string;
    from?: string;
    to?: string;
    subject?: string;
    isRead?: boolean;
    isStarred?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
    limit?: number;
  }): Promise<{ folder: string; total: number; emails: EmailSummary[] }> {
    return this.withMailbox(folder, async () => {
      const client = await this.getClient();
      const searchObject: Record<string, unknown> = {};

      if (search.query) {
        searchObject.text = search.query;
      }
      if (search.from) {
        searchObject.from = search.from;
      }
      if (search.to) {
        searchObject.to = search.to;
      }
      if (search.subject) {
        searchObject.subject = search.subject;
      }
      if (typeof search.isRead === "boolean") {
        searchObject.seen = search.isRead;
      }
      if (typeof search.isStarred === "boolean") {
        searchObject.flagged = search.isStarred;
      }
      if (search.dateFrom) {
        searchObject.since = search.dateFrom;
      }
      if (search.dateTo) {
        searchObject.before = search.dateTo;
      }

      const uids = await client.search(searchObject, { uid: true });
      const limitedUids = Array.isArray(uids)
        ? uids.slice(-Math.max(1, search.limit ?? 100))
        : [];

      const emails: EmailSummary[] = [];
      if (limitedUids.length === 0) {
        return { folder, total: 0, emails };
      }

      for await (const message of client.fetch(limitedUids, {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        size: true,
      }, { uid: true })) {
        emails.push({
          id: message.uid ?? message.seq,
          ...this.envelopeToSummary(message.envelope),
          flags: Array.from(message.flags ?? []),
          size: message.size,
        });
      }

      emails.sort((a, b) => {
        if (!a.date || !b.date) {
          return 0;
        }
        return b.date.localeCompare(a.date);
      });

      return { folder, total: limitedUids.length, emails };
    });
  }

  async getThread(
    folder: string,
    threadId: string,
    limit: number
  ): Promise<{ folder: string; threadId: string; total: number; emails: EmailSummary[] }> {
    return this.withMailbox(folder, async () => {
      const client = await this.getClient();
      const searchObject: SearchObject = {
        or: [
          { header: { "Message-ID": threadId } },
          { header: { "In-Reply-To": threadId } },
          { header: { References: threadId } },
        ],
      };

      const uids = await client.search(searchObject, { uid: true });
      const limitedUids = Array.isArray(uids)
        ? uids.slice(-Math.max(1, limit))
        : [];

      const emails: EmailSummary[] = [];
      if (limitedUids.length === 0) {
        return { folder, threadId, total: 0, emails };
      }

      for await (const message of client.fetch(limitedUids, {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        size: true,
      }, { uid: true })) {
        emails.push({
          id: message.uid ?? message.seq,
          ...this.envelopeToSummary(message.envelope),
          flags: Array.from(message.flags ?? []),
          size: message.size,
        });
      }

      emails.sort((a, b) => {
        if (!a.date || !b.date) {
          return 0;
        }
        return b.date.localeCompare(a.date);
      });

      return { folder, threadId, total: limitedUids.length, emails };
    });
  }

  async setEmailRead(folder: string, emailId: number, isRead: boolean): Promise<boolean> {
    return this.withMailbox(folder, async () => {
      const client = await this.getClient();
      const result = isRead
        ? await client.messageFlagsAdd(emailId, ["\\Seen"], { uid: true })
        : await client.messageFlagsRemove(emailId, ["\\Seen"], { uid: true });
      this.invalidateFolderCaches(folder);
      this.invalidateEmailCache(folder, emailId);
      return result;
    });
  }

  async setEmailStarred(folder: string, emailId: number, isStarred: boolean): Promise<boolean> {
    return this.withMailbox(folder, async () => {
      const client = await this.getClient();
      const result = isStarred
        ? await client.messageFlagsAdd(emailId, ["\\Flagged"], { uid: true })
        : await client.messageFlagsRemove(emailId, ["\\Flagged"], { uid: true });
      this.invalidateFolderCaches(folder);
      this.invalidateEmailCache(folder, emailId);
      return result;
    });
  }

  async moveEmail(folder: string, emailId: number, targetFolder: string): Promise<boolean> {
    return this.withMailbox(folder, async () => {
      const client = await this.getClient();
      const result = await client.messageMove(emailId, targetFolder, { uid: true });
      this.invalidateFolderCaches(folder);
      this.invalidateFolderCaches(targetFolder);
      this.invalidateEmailCache(folder, emailId);
      return Boolean(result);
    });
  }

  private async resolveTrashFolder(): Promise<string | null> {
    const folders = await this.listFolders();
    const specialUseTrash = folders.find((folder) => folder.specialUse?.toLowerCase() === "\\trash");
    if (specialUseTrash) {
      return specialUseTrash.path;
    }

    const nameMatches = folders.find((folder) => {
      const name = folder.name.toLowerCase();
      return name === "trash" || name === "deleted items" || name === "deleted messages" || name === "deleted mail";
    });
    if (nameMatches) {
      return nameMatches.path;
    }

    const pathMatches = folders.find((folder) => {
      const path = folder.path.toLowerCase();
      return path.includes("trash") || path.includes("deleted");
    });
    return pathMatches?.path ?? null;
  }

  async deleteEmail(folder: string, emailId: number): Promise<boolean> {
    return this.withMailbox(folder, async () => {
      const client = await this.getClient();
      const trashFolder = await this.resolveTrashFolder();
      if (!trashFolder) {
        throw new Error("Trash folder not found; refusing to permanently delete email.");
      }
      if (trashFolder === folder) {
        return true;
      }
      const result = await client.messageMove(emailId, trashFolder, { uid: true });
      this.invalidateFolderCaches(folder);
      this.invalidateFolderCaches(trashFolder);
      this.invalidateEmailCache(folder, emailId);
      return Boolean(result);
    });
  }

  async getContacts(folder: string, limit: number): Promise<Array<{ address?: string; name?: string; count: number }>> {
    const { emails } = await this.getEmails(folder, Math.max(limit, 200), 0);
    const counts = new Map<string, { address?: string; name?: string; count: number }>();

    for (const email of emails) {
      const from = email.from ?? [];
      for (const contact of from) {
        const key = contact.address ?? contact.name ?? "unknown";
        const existing = counts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(key, {
            address: contact.address,
            name: contact.name,
            count: 1,
          });
        }
      }
    }

    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  async getVolumeTrends(folder: string, days: number): Promise<Array<{ date: string; count: number }>> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Math.max(1, days) + 1);

    const { emails } = await this.searchEmails(folder, {
      dateFrom: cutoff,
      limit: 1000,
    });

    const buckets = new Map<string, number>();
    for (const email of emails) {
      if (!email.date) {
        continue;
      }
      const day = email.date.slice(0, 10);
      buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  }

  clearCache(): void {
    this.folderCache = null;
    this.mailboxStatusCache.clear();
    this.emailsCache.clear();
    this.emailByIdCache.clear();
  }

  getCacheSnapshot(): {
    folders: number;
    mailboxStatus: number;
    emailLists: number;
    emailDetails: number;
  } {
    return {
      folders: this.folderCache ? this.folderCache.length : 0,
      mailboxStatus: this.mailboxStatusCache.size,
      emailLists: this.emailsCache.size,
      emailDetails: this.emailByIdCache.size,
    };
  }

  startRealtimeSync(
    folder: string,
    intervalMs: number,
    onUpdate?: (status: MailboxStatusSummary) => void,
  ): void {
    if (this.realtimeSyncTimers.has(folder)) {
      return;
    }
    let lastStatus: MailboxStatusSummary | null = null;
    const poll = async () => {
      try {
        if (!this.isConnected()) {
          await this.reconnect();
        }
        const status = await this.getMailboxStatus(folder);
        if (
          !lastStatus ||
          status.totalMessages !== lastStatus.totalMessages ||
          status.unseenMessages !== lastStatus.unseenMessages
        ) {
          lastStatus = status;
          onUpdate?.(status);
          void this.syncFolderCaches(folder);
        }
      } catch (error) {
        logger.warn("Realtime sync polling failed", "SimpleIMAPService", error);
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, intervalMs);
    this.realtimeSyncTimers.set(folder, timer);
  }

  stopRealtimeSync(folder: string): void {
    const timer = this.realtimeSyncTimers.get(folder);
    if (timer) {
      clearInterval(timer);
      this.realtimeSyncTimers.delete(folder);
    }
  }

  private async reconnect(): Promise<void> {
    try {
      await this.disconnect();
    } catch (error) {
      logger.warn("IMAP disconnect failed during reconnect", "SimpleIMAPService", error);
    }
    try {
      await this.connect();
    } catch (error) {
      logger.warn("IMAP reconnect attempt failed", "SimpleIMAPService", error);
    }
  }

  private async syncFolderCaches(folder: string): Promise<void> {
    if (!this.isCacheEnabled() || this.realtimeSyncInFlight.has(folder)) {
      return;
    }
    this.realtimeSyncInFlight.add(folder);
    try {
      const cachedKeys = Array.from(this.emailsCache.keys()).filter((key) => key.startsWith(`${folder}:`));
      if (cachedKeys.length === 0) {
        const seed = await this.fetchEmailsFromServer(folder, 50, 0);
        this.emailsCache.set(`${folder}:50:0`, seed);
      } else {
        await Promise.all(
          cachedKeys.map(async (key) => {
            const [, limitRaw, offsetRaw] = key.split(":");
            const limit = Number(limitRaw);
            const offset = Number(offsetRaw);
            if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
              return;
            }
            const refreshed = await this.fetchEmailsFromServer(folder, limit, offset);
            this.emailsCache.set(key, refreshed);
          }),
        );
      }
      for (const key of Array.from(this.emailByIdCache.keys())) {
        if (key.startsWith(`${folder}:`)) {
          this.emailByIdCache.delete(key);
        }
      }
      this.folderCache = null;
      this.mailboxStatusCache.delete(folder);
    } catch (error) {
      logger.warn("Realtime sync cache refresh failed", "SimpleIMAPService", error);
    } finally {
      this.realtimeSyncInFlight.delete(folder);
    }
  }
}
