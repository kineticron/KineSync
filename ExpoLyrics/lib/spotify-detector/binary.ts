// Wire field numbers from librespot's connect.proto and player.proto (MIT).
// Only decode state/identity fields; skip queues, transfer data, and commands.
// https://github.com/librespot-org/librespot/tree/dev/protocol/proto
type Field = { id: number; wire: number; value: number | Uint8Array };
function fields(bytes: Uint8Array): Field[] {
  let pos = 0;
  const readVarint = () => {
    let result = 0;
    let multiplier = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= bytes.length) throw new Error('Truncated protobuf varint');
      const b = bytes[pos++];
      result += (b & 127) * multiplier;
      if (!(b & 128)) return result;
      multiplier *= 128;
    }
    throw new Error('Invalid protobuf varint');
  };
  const out: Field[] = [];
  while (pos < bytes.length) {
    const tag = readVarint(), wire = tag & 7, id = Math.floor(tag / 8);
    if (!id) throw new Error('Invalid protobuf field');
    if (wire === 0) out.push({ id, wire, value: readVarint() });
    else {
      const length = wire === 2 ? readVarint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (length < 0 || !Number.isSafeInteger(length) || length > bytes.length - pos) throw new Error('Invalid protobuf length');
      out.push({ id, wire, value: bytes.subarray(pos, pos + length) }); pos += length;
    }
    if (out.length > 100000) throw new Error('Protobuf field limit exceeded');
  }
  return out;
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function track(bytes: Uint8Array) {
  const out: any = { metadata: Object.create(null) };
  for (const f of fields(bytes)) if (f.wire === 2) {
    if (f.id === 1) out.uri = text(f.value as Uint8Array);
    if (f.id === 3) {
      const entry = fields(f.value as Uint8Array);
      const key = entry.find(e => e.id === 1 && e.wire === 2);
      const value = entry.find(e => e.id === 2 && e.wire === 2);
      if (key && value) out.metadata[text(key.value as Uint8Array)] = text(value.value as Uint8Array);
    }
  }
  return out;
}
function player(bytes: Uint8Array) {
  // Proto3 omits false/zero fields. Supply defaults to preserve pause/position.
  const out: any = { position_as_of_timestamp: 0, duration: 0, is_playing: false, is_paused: false, is_buffering: false };
  const numbers: Record<number, string> = { 1: 'timestamp', 10: 'position_as_of_timestamp', 11: 'duration', 25: 'position' };
  const bools: Record<number, string> = { 12: 'is_playing', 13: 'is_paused', 14: 'is_buffering' };
  for (const f of fields(bytes)) {
    if (f.wire === 0 && numbers[f.id]) out[numbers[f.id]] = f.value;
    if (f.wire === 0 && bools[f.id]) out[bools[f.id]] = !!f.value;
    if (f.wire === 2 && f.id === 7) out.track = track(f.value as Uint8Array);
  }
  return out;
}
function device(bytes: Uint8Array) {
  const out: any = {};
  for (const f of fields(bytes)) if (f.wire === 2 && (f.id === 3 || f.id === 10)) out[f.id === 3 ? 'name' : 'device_id'] = text(f.value as Uint8Array);
  return out;
}
export function decodeCluster(bytes: Uint8Array, wrapped = false): any {
  if (bytes.length > 4 * 1024 * 1024) throw new Error('State payload too large');
  const outer = fields(bytes);
  // ClusterUpdate field 1 is a nested Cluster; Cluster field 1 is a timestamp.
  const nested = outer.find(f => f.id === 1 && f.wire === 2);
  if (wrapped && nested) return { cluster: decodeCluster(nested.value as Uint8Array) };
  const out: any = { device: Object.create(null) };
  for (const f of outer) {
    if (f.wire === 2 && f.id === 2) out.active_device_id = text(f.value as Uint8Array);
    if (f.wire === 2 && f.id === 3) out.player_state = player(f.value as Uint8Array);
    if (f.wire === 2 && f.id === 4) {
      const entry = fields(f.value as Uint8Array);
      const key = entry.find(e => e.id === 1 && e.wire === 2);
      const value = entry.find(e => e.id === 2 && e.wire === 2);
      if (key && value) out.device[text(key.value as Uint8Array)] = device(value.value as Uint8Array);
    }
  }
  if (!out.player_state && !out.active_device_id) throw new Error('No Connect cluster fields');
  return out;
}
