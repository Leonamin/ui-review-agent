/** UUID v4 for browser identity keys, including non-loopback HTTP dashboards.
 * getRandomValues is available there even when secure-context randomUUID is not.
 */
export function createBrowserId(source: {getRandomValues(bytes: Uint8Array): Uint8Array} = globalThis.crypto): string {
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
