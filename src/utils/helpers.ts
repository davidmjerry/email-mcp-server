export function parseEmails(input: string | undefined | null): string[] {
  if (!input) {
    return [];
  }
  return input
    .split(",")
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function renderTemplate(template: string, data: Record<string, string | number | boolean>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      return String(data[key]);
    }
    return match;
  });
}
