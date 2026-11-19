export type ReviewCredentials =
  | { method: 'password'; username: string; password: string }
  | { method: 'code'; code: string };

export function canUseReviewCredentials(targetUrl: string): boolean {
  try {
    const url = new URL(targetUrl);
    return !url.username && !url.password &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch {
    return false;
  }
}
