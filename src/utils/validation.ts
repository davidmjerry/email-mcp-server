import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const assertObject = (value: unknown, toolName: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpError(ErrorCode.InvalidParams, `${toolName} requires an object argument`);
  }
  return value as Record<string, unknown>;
};

export const assertNoUnknownKeys = (args: Record<string, unknown>, allowed: string[], toolName: string): void => {
  const allowedSet = new Set(allowed);
  const unknownKeys = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unknownKeys.length > 0) {
    throw new McpError(ErrorCode.InvalidParams, `${toolName} received unknown parameters: ${unknownKeys.join(", ")}`);
  }
};

export const requireString = (args: Record<string, unknown>, key: string, toolName: string): string => {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new McpError(ErrorCode.InvalidParams, `${toolName} requires ${key} to be a non-empty string`);
  }
  return value.trim();
};

export const optionalString = (args: Record<string, unknown>, key: string, toolName: string): string | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new McpError(ErrorCode.InvalidParams, `${toolName} requires ${key} to be a string`);
  }
  return value;
};

export const optionalBoolean = (args: Record<string, unknown>, key: string, toolName: string): boolean | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new McpError(ErrorCode.InvalidParams, `${toolName} requires ${key} to be a boolean`);
  }
  return value;
};

export const optionalNumber = (args: Record<string, unknown>, key: string, toolName: string): number | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new McpError(ErrorCode.InvalidParams, `${toolName} requires ${key} to be a number`);
  }
  return value;
};

export const parseDateInput = (value: string, field: string, toolName: string): Date => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new McpError(ErrorCode.InvalidParams, `${toolName} requires ${field} to be a valid ISO date string`);
  }
  return parsed;
};

const isDateOnly = (value: string): boolean => DATE_ONLY_REGEX.test(value);

export const normalizeDateRange = (
  dateFrom: string | undefined,
  dateTo: string | undefined,
  toolName: string
): { since?: Date; before?: Date } => {
  const since = dateFrom ? parseDateInput(dateFrom, "dateFrom", toolName) : undefined;
  let before: Date | undefined;

  if (dateTo) {
    const parsedTo = parseDateInput(dateTo, "dateTo", toolName);
    if (isDateOnly(dateTo)) {
      before = new Date(parsedTo.getTime() + 24 * 60 * 60 * 1000);
    } else {
      before = new Date(parsedTo.getTime() + 1);
    }
  }

  if (since && before && before.getTime() < since.getTime()) {
    throw new McpError(ErrorCode.InvalidParams, `${toolName} requires dateTo to be after dateFrom`);
  }

  return { since, before };
};
