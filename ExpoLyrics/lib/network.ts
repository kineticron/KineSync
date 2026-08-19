export function extractHost(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }
  const raw = value.trim();
  if (!raw) {
    return '';
  }
  const withoutScheme = raw.replace(/^[a-z]+:\/\//i, '');
  const firstSegment = withoutScheme.split('/')[0] || '';
  const host = firstSegment.split(':')[0] || '';
  return host.trim();
}

export function isPrivateIpv4(host: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const octets = host.split('.').map((part) => Number(part));
  const isIpv4 =
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  if (!isIpv4) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

/** Validate bridge endpoints before they reach WebSocket (or the QR parser). */
export function parseBridgeWebSocketUrl(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateIpv6 =
    host.includes(':') &&
    (/^f[cd](?:[0-9a-f]{0,2}):/i.test(host) ||
      /^fe[89ab][0-9a-f]?:/i.test(host));
  const privateHost =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    isPrivateIpv4(host) ||
    privateIpv6;
  // Cleartext is deliberately limited to a host that is local/LAN. Public
  // bridge URLs must use TLS so a QR code cannot silently downgrade a session.
  if (parsed.protocol === 'ws:' && !privateHost) return null;
  return parsed.toString().replace(/\/$/, '');
}

export function isValidBridgeKey(value: unknown): value is string {
  const key = typeof value === 'string' ? value.trim() : '';
  const lower = key.toLowerCase();
  return (
    key.length >= 16 &&
    key.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(key) &&
    !['password123', 'password', 'changeme', 'change-me', 'bridge-key', 'default', 'kinesync', 'secret', 'test'].includes(lower) &&
    !/^(.)(\1){15,}$/.test(key)
  );
}
