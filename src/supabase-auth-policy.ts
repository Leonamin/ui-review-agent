export const PROJECT_SUPABASE_AUTH_BINDING_LIMIT = 20;

export interface ProjectSupabaseAuthBinding {
  targetOrigin: string;
  origin: string;
}

export function normalizeReviewTargetOrigin(raw: string): string | undefined {
  const value = raw.trim();
  if (!/^https:\/\/[a-z\d.-]+(?::\d+)?\/?$/i.test(value)) return;
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (!url.hostname.includes('.') || url.hostname.length > 253 ||
      !url.hostname.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) ||
      !/^[a-z]/.test(url.hostname.split('.').at(-1)!) ||
      /(?:^|\.)(?:localhost|localdomain|local|internal|onion)$|(?:^|\.)home\.arpa$/.test(url.hostname)) return;
  return url.origin;
}

export function normalizeSupabaseAuthOrigin(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  if (!/^https:\/\/[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.supabase\.co\/?$/.test(value)) return;
  return value.replace(/\/$/, '');
}
