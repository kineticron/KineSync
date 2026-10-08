import { Buffer } from 'buffer';
import { ungzip } from 'pako';
import { decodeCluster } from './binary';

export type Sample = { title: string; artist: string; album: string; artworkUrl: string; uri: string; positionMs: number; durationMs: number; playing: boolean; device: string; receivedAt: number; positionTimestampMs?: number; activeDeviceId?: string };

export function projectedPosition(sample: Sample, now: number): number {
  const basis = sample.positionTimestampMs ?? sample.receivedAt;
  const position = sample.positionMs + (sample.playing ? Math.max(0, now - basis) : 0);
  return sample.durationMs > 0 ? Math.min(position, sample.durationMs) : position;
}

export function spotifyHost(raw: string, socket = false): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === (socket ? 'wss:' : 'https:') && !u.username && !u.password &&
      (u.hostname === 'spotify.com' || u.hostname.endsWith('.spotify.com'));
  } catch { return false; }
}

export function readEndpoint(raw: string): boolean {
  if (!spotifyHost(raw)) return false;
  const p = new URL(raw).pathname;
  return /\/connect-state\/|\/player\/(?:v\d+\/)?state|\/track-playback\/v\d+\/devices/.test(p);
}

// Register our own non-playing observer, never reuse the web player's device ID.
export function observerEndpoint(raw: string, deviceId: string): string | null {
  if (!spotifyHost(raw) || !/^[a-f0-9]{40}$/.test(deviceId)) return null;
  const u = new URL(raw);
  if (!/^\/connect-state\/v1\/devices\/[^/]+$/.test(u.pathname)) return null;
  const observedId = u.pathname.split('/').pop()!;
  const ownId = observedId.startsWith('hobs_') ? `hobs_${deviceId.slice(0, observedId.length - 5)}` : deviceId;
  u.pathname = `/connect-state/v1/devices/${ownId}`;
  u.search = '';
  return u.toString();
}

export function observerBody() {
  // Match the successfully captured browser observer JSON, not audio registration.
  // The observer identity belongs to the URL. Unspecified playback flags default false.
  return {
    member_type: 'CONNECT_STATE',
    device: { device_info: {
      capabilities: { can_be_player: false, hidden: true, needs_full_player_state: true },
    } },
  };
}

export function connectionIdFrom(value: unknown): string | null {
  const h = (value as any)?.headers;
  if (!h || typeof h !== 'object') return null;
  const entry = Object.entries(h).find(([k, v]) => k.toLowerCase() === 'spotify-connection-id' && typeof v === 'string');
  return entry ? String(entry[1]) : null;
}

export function decodeDealer(value: unknown): unknown {
  const o = value as any;
  if (!o || !Array.isArray(o.payloads)) return value;
  const gzip = Object.entries(o.headers ?? {}).some(([k, v]) => k.toLowerCase() === 'transfer-encoding' && v === 'gzip');
  return { ...o, payloads: o.payloads.map((p: unknown) => {
    if (typeof p !== 'string' && !Array.isArray(p)) return p;
    if (typeof p === 'string') { try { return JSON.parse(p); } catch {} }
    const data = typeof p === 'string' ? new Uint8Array(Buffer.from(p, 'base64')) : Uint8Array.from(p as number[]);
    // Native Expo includes TextDecoder. pako handles UTF-8 for compressed JSON.
    const bytes = gzip ? ungzip(data) : data;
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch {
      const uri = String(o.uri ?? (o.uris ?? []).join(' '));
      if (/connect-state\/v1\/cluster/.test(uri)) return decodeCluster(bytes, true);
      throw new Error('Unsupported binary event');
    }
  }) };
}

export function decodeStateBody(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return decodeCluster(bytes); }
}

export function stateFingerprint(s: Sample): string {
  return JSON.stringify([s.uri, s.title, s.artist, s.album, s.artworkUrl, s.positionMs, s.durationMs, s.playing, s.activeDeviceId, s.positionTimestampMs]);
}

// Describe schemas and sizes, not credential values or raw body contents.
export function eventSummary(value: unknown): string {
  const o = value as any;
  if (!o || typeof o !== 'object') return 'non-object';
  const uri = String(o.uri ?? (o.uris ?? []).join(' '));
  const types = (o.payloads ?? []).map((p: any) => typeof p === 'string' ? `encoded/string(${p.length})` : Array.isArray(p) ? `bytes(${p.length})` : `object:${Object.keys(p ?? {}).slice(0, 8).join(',')}`);
  return `${o.type ?? 'response'} ${uri} payloads=[${types.join(';')}] keys=[${Object.keys(o).slice(0, 8).join(',')}]`;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /token|authorization|cookie|credential|secret/i.test(k) ? '[redacted]' : redact(v)]));
  if (typeof value === 'string') return value.replace(/([?&](?:access_token|token|client_token)=)[^&\s]+/gi, '$1[redacted]').replace(/Bearer\s+[^\s"]+/gi, 'Bearer [redacted]');
  return value;
}

// Accept only recognizable playback objects; arbitrary network messages aren't proof of state.
export function sampleFrom(value: unknown, depth = 0): Sample | null {
  if (depth > 9 || !value) return null;
  if (typeof value === 'string') { try { return sampleFrom(JSON.parse(value), depth + 1); } catch { return null; } }
  if (typeof value !== 'object') return null;
  const o = value as Record<string, any>;
  if (o.player_state) {
    const s = sampleFrom(o.player_state, depth + 1);
    if (s) {
      const id = o.active_device_id ?? o.activeDeviceId;
      const info = o.device?.[id] ?? o.devices?.[id];
      return { ...s, activeDeviceId: id, device: info?.name ?? info?.device_info?.name ?? id ?? s.device };
    }
  }
  const track = o.track_window?.current_track ?? o.track ?? o.item;
  const position = Number(o.position_as_of_timestamp ?? o.position ?? o.progress_ms);
  const paused = typeof o.is_paused === 'boolean' ? o.is_paused : o.paused;
  // Spotify can report is_playing=true AND is_paused=true for a paused session.
  const playing = paused === true ? false : typeof o.is_playing === 'boolean' ? o.is_playing : typeof paused === 'boolean' ? !paused : undefined;
  if (track && Number.isFinite(position) && playing !== undefined) {
    const m = track.metadata ?? {};
    return {
      title: track.name ?? m.title ?? 'Unknown track',
      artist: track.artists?.map((a: any) => a.name).join(', ') || m.artist_name || m['artist_name:0'] || '',
      album: track.album?.name ?? m.album_title ?? '',
      artworkUrl: String(track.album?.images?.[0]?.url ?? m.image_xlarge_url ?? m.image_large_url ?? m.image_url ?? '').replace(/^spotify:image:/, 'https://i.scdn.co/image/'),
      uri: track.uri ?? '', positionMs: Math.max(0, position),
      durationMs: Number(o.duration ?? track.duration_ms ?? m.duration) || 0,
      playing: playing && !o.loading && !o.is_buffering,
      device: o.device?.name ?? o.device?.device_id ?? '', receivedAt: Date.now(),
      positionTimestampMs: Number(o.timestamp) > 1_000_000_000_000 ? Number(o.timestamp) : undefined,
    };
  }
  for (const v of Object.values(o)) { const s = sampleFrom(v, depth + 1); if (s) return s; }
  return null;
}
