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
  const octets = host.split('.').map((part) => Number.parseInt(part, 10));
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
