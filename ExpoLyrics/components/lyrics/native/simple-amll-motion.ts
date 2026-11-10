import { cancelAnimation, type AnimatedRef, type SharedValue } from 'react-native-reanimated';
import type { ScrollView } from 'react-native';
import type { ReferenceScroll, RowMotionEntry, RowState, ScrollCommand } from './reference-scroll';
import type { BatchedMotion } from './batched-amll-motion';


export type SimpleCellSlot = { owner: Readonly<{ value: unknown }>; p: number; lead: number; settled: boolean };

export type SimpleScrollSegment = {
  startTime: number;
  endTime: number;
  p0: number;
  v0: number;
  omega: number;
  c1: number;
  c2: number;
  targetShift: number;
};

export type SimpleScrollRowSlot = {
  state: SharedValue<RowState>;
  output: SharedValue<number>;
  delay: number;
  targetDelay: number;
  sleeping: boolean;
  command: ScrollCommand;
};

export type SimpleScrollState = {
  timeline: number;
  segments: SimpleScrollSegment[];
  rows: Record<number, SimpleScrollRowSlot>;
  cells: Record<number, SimpleCellSlot>;
  dirty: boolean;
  awake?: boolean;
  command?: ScrollCommand;
};

export function createSimpleScrollState(): SimpleScrollState {
  return {
    timeline: 0,
    segments: [],
    rows: {},
    cells: {},
    dirty: false,
    awake: false,
  };
}

export function amllRowCascadeDelay(command: { firstVisible: number; index: number }, rowIndex: number): number {
  'worklet';
  let delay = 0;
  let step = 0.05;
  for (let i = command.firstVisible; i < rowIndex; i++) {
    delay += step;
    if (i >= command.index) step /= 1.05;
  }
  return delay;
}

export function amllOmega(interval: number, interlude: boolean): number {
  'worklet';
  const ratio = (1 - (Math.max(100, Math.min(800, interval)) - 100) / 700) ** 0.2;
  const stiffness = interlude ? 90 : 170 + ratio * 50;
  return Math.sqrt(stiffness / 0.9);
}

export function sampleTrajectory(segments: SimpleScrollSegment[], T: number): { p: number; v: number; settled: boolean } {
  'worklet';
  if (!segments || segments.length === 0) return { p: 0, v: 0, settled: true };
  const last = segments[segments.length - 1];
  if (T >= last.startTime) {
    const t = Math.max(0, T - last.startTime);
    const decay = Math.exp(-last.omega * t);
    const p = (last.c1 + last.c2 * t) * decay;
    const v = (last.v0 - last.omega * last.c2 * t) * decay;
    const settled = Math.abs(p) < 0.01 && Math.abs(v) < 0.01;
    return { p: settled ? 0 : p, v: settled ? 0 : v, settled };
  }
  for (let i = segments.length - 2; i >= 0; i--) {
    const seg = segments[i];
    if (T >= seg.startTime) {
      const t = Math.max(0, Math.min(seg.endTime - seg.startTime, T - seg.startTime));
      const decay = Math.exp(-seg.omega * t);
      const p = (seg.c1 + seg.c2 * t) * decay + seg.targetShift;
      const v = (seg.v0 - seg.omega * seg.c2 * t) * decay;
      return { p, v, settled: false };
    }
  }
  const first = segments[0];
  return { p: first.c1 + first.targetShift, v: 0, settled: false };
}

export function boundAnalyticDisplacement(
  segments: SimpleScrollSegment[],
  tCurrent: number,
  windowSec: number,
): number {
  'worklet';
  const cur = sampleTrajectory(segments, tCurrent);
  if (cur.settled) return 0;
  const atEnd = sampleTrajectory(segments, tCurrent + windowSec);
  const atMid = sampleTrajectory(segments, tCurrent + windowSec * 0.5);
  let maxDev = Math.max(Math.abs(atEnd.p - cur.p), Math.abs(atMid.p - cur.p));
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (tCurrent + windowSec < seg.startTime) continue;
    if (tCurrent > seg.endTime) break;
    if (Math.abs(seg.c2) > 1e-6) {
      const tStar = seg.startTime + seg.v0 / (seg.omega * seg.c2);
      if (tStar > tCurrent && tStar < tCurrent + windowSec) {
        const atStar = sampleTrajectory(segments, tStar);
        maxDev = Math.max(maxDev, Math.abs(atStar.p - cur.p));
      }
    }
  }
  return maxDev;
}

export function removeSimpleScrollRow(host: ReferenceScroll, index: number, owner: Readonly<{ value: unknown }>) {
  'worklet';
  if (!host.simple) return;
  host.simple.modify(value => {
    if (value.rows[index]?.output === owner) {
      delete value.rows[index];
      value.dirty = true;
    }
    return value;
  });
}

export function prepareSimpleScrollRow(
  host: ReferenceScroll,
  index: number,
  enabled: boolean,
  state: SharedValue<RowState>,
  output: SharedValue<number>,
  command: ScrollCommand,
  previous: { command: ScrollCommand; index: number } | null,
) {
  'worklet';
  const simple = host.simple;
  if (!simple) return;
  if (previous && previous.index !== index) removeSimpleScrollRow(host, previous.index, output);
  if (!enabled) { removeSimpleScrollRow(host, index, output); return; }
  const targetDelay = command.geometry ? 0 : amllRowCascadeDelay(command, index);
  if (!previous || previous.index !== index || !simple.value.rows[index]) {
    state.value = { ...state.value, p: host.residual.value, v: 0, renderedP: host.renderedResidual.value, delay: targetDelay, prevResidual: host.renderedResidual.value };
    output.value = 0;
  }
  simple.modify(value => {
    const existing = value.rows[index];
    const delay = existing ? existing.delay : targetDelay;
    value.rows[index] = { state, output, delay, targetDelay, sleeping: false, command };
    value.awake = true;
    value.dirty = true;
    return value;
  });
}

export function applySimpleScrollCommand(
  host: ReferenceScroll,
  nativeRef: AnimatedRef<ScrollView>,
  command: ScrollCommand,
  previous: ScrollCommand | null,
  scrollTo: (ref: AnimatedRef<ScrollView>, x: number, y: number, animated: boolean) => void,
) {
  'worklet';
  const simple = host.simple!;
  cancelAnimation(host.residual);
  if (command.instant) {
    host.residual.value = 0;
    host.renderedResidual.value = 0;
    scrollTo(nativeRef, 0, command.offset, false);
    simple.modify(value => {
      value.segments = [];
      value.awake = false;
      value.dirty = true;
      for (const key in value.rows) {
        const slot = value.rows[Number(key)];
        slot.output.value = 0;
        slot.delay = 0;
        slot.targetDelay = 0;
        slot.sleeping = true;
        slot.state.value = { ...slot.state.value, p: 0, v: 0, renderedP: 0, delay: 0, prevResidual: 0 };
      }
      return value;
    }, false);
    return;
  }
  const T = simple.value.timeline;
  const current = sampleTrajectory(simple.value.segments, T);
  const pNow = current.settled ? 0 : current.p;
  const vNow = current.settled ? 0 : current.v;
  const delta = command.geometry ? command.delta : (previous?.snap ? command.delta : command.offset - host.actualOffset.value);
  const p0 = pNow + delta;
  const v0 = vNow;
  const omega = amllOmega(command.interval, Boolean(command.interlude));
  const c1 = p0;
  const c2 = v0 + omega * p0;
  host.residual.value = p0;
  simple.modify(value => {
    if (value.segments.length > 0) {
      value.segments[value.segments.length - 1].endTime = T;
      for (const seg of value.segments) seg.targetShift += delta;
      while (value.segments.length > 1 && value.segments[0].endTime < T - 1.5) {
        value.segments.shift();
      }
    }
    value.segments.push({
      startTime: T,
      endTime: Infinity,
      p0,
      v0,
      omega,
      c1,
      c2,
      targetShift: 0,
    });
    for (const key in value.rows) {
      const index = Number(key);
      const slot = value.rows[index];
      slot.targetDelay = command.geometry ? 0 : amllRowCascadeDelay(command, index);
      slot.sleeping = false;
    }
    value.awake = true;
    value.dirty = true;
    return value;
  }, false);
}

export function advanceSimpleAmllMotion(
  host: ReferenceScroll,
  elapsed: number | null,
  nativeRef: AnimatedRef<ScrollView>,
  scrollTo: (ref: AnimatedRef<ScrollView>, x: number, y: number, animated: boolean) => void,
) {
  'worklet';
  const simple = host.simple!;
  const residual = host.residual.value;
  if (simple.value.awake === false && !simple.value.dirty && residual === 0) return;
  const dt = Math.min(0.064, Math.max(0, (elapsed ?? 0) / 1000)) || (1 / 60);
  const previous = host.batchRows?.value ?? {};
  let changed = simple.value.dirty;
  const registry: Record<number, RowMotionEntry> = {};
  simple.modify(value => {
    value.timeline += dt;
    const T = value.timeline;
    const viewportSample = sampleTrajectory(value.segments, T);
    const viewportP = viewportSample.settled ? 0 : viewportSample.p;
    const viewportV = viewportSample.settled ? 0 : viewportSample.v;
    host.residual.value = viewportP;
    if (host.command.value.snap) {
      scrollTo(nativeRef, 0, Math.max(0, host.command.value.offset - viewportP), false);
    }
    host.renderedResidual.value = viewportP;
    const rendered = viewportP;
    value.awake = !viewportSample.settled || viewportP !== 0;
    for (const key in value.rows) {
      const index = Number(key);
      const slot = value.rows[index];
      const prevDelay = slot.delay;
      if (Math.abs(slot.delay - slot.targetDelay) > 1e-4) {
        const step = 0.5 * dt;
        slot.delay += Math.max(-step, Math.min(step, slot.targetDelay - slot.delay));
      }
      const delayRate = dt > 0 ? (slot.delay - prevDelay) / dt : 0;
      const rowSample = sampleTrajectory(value.segments, T - slot.delay);
      const rowP = rowSample.settled ? 0 : rowSample.p;
      const rowV = rowSample.settled ? 0 : rowSample.v;
      const rowVActual = rowV * (1 - delayRate);
      const settled = rowSample.settled && viewportSample.settled;
      slot.sleeping = settled && viewportP === 0;
      if (!slot.sleeping) value.awake = true;
      const exact = host.command.value.snap ? rowP - rendered : 0;
      if (exact === 0 || Math.abs(exact - slot.output.value) >= 1e-7) slot.output.value = exact;
      const hidden = Math.abs(exact - slot.output.value);
      const rowDev = boundAnalyticDisplacement(value.segments, T - slot.delay, 0.096);
      const viewportDev = boundAnalyticDisplacement(value.segments, T, 0.064);
      const vBound = (Math.abs(rowVActual) + Math.abs(viewportV)) * 0.064;
      const hostStep = Math.abs(rendered - slot.state.value.prevResidual);
      const rowLead = settled && viewportP === 0 ? 0 : Math.max(rowDev + viewportDev, vBound, hostStep) + 0.02;
      const rowVLead = rowLead + hidden;
      const cellP = 0;
      const cellLead = 0;
      const entry: RowMotionEntry = {
        owner: slot.output,
        row: slot.output.value,
        cell: cellP,
        rowVLead,
        cellVLead: cellLead,
        vLead: rowVLead + cellLead,
        settled: settled && cellP === 0,
      };
      slot.state.modify(current => {
        current.p = rowP;
        current.v = rowVActual;
        current.renderedP = rowP;
        current.delay = slot.delay;
        current.prevResidual = rendered;
        return current;
      }, false);
      const old = previous[index];
      const lead = entry.vLead ?? 0;
      const oldLead = old?.vLead ?? 0;
      if (old && old.owner === slot.output && old.settled === entry.settled &&
          Math.abs(old.row - entry.row) < 0.001 && Math.abs(old.cell - cellP) < 0.001 &&
          Math.abs(oldLead - lead) < 0.001 &&
          old.row + old.cell - oldLead <= entry.row + cellP - lead &&
          old.row + old.cell + oldLead >= entry.row + cellP + lead) {
        registry[index] = old;
      } else {
        registry[index] = entry;
        changed = true;
      }
    }
    value.dirty = false;
    return value;
  }, false);
  if (changed && host.batchRows) host.batchRows.value = registry;
}

export function composeSimpleRegistry(rows: Record<number, RowMotionEntry>, simple: SimpleScrollState, batch?: BatchedMotion): Record<number, RowMotionEntry> {
  'worklet';
  const result: Record<number, RowMotionEntry> = {};
  for (const key in simple.rows) {
    const index = Number(key);
    const slot = simple.rows[index];
    const candidate = rows[index];
    const row = candidate?.owner === slot.output ? candidate : undefined;
    const rowLead = row ? row.rowVLead ?? 0 : Infinity;
    const cell = batch?.cells[index] || simple.cells[index];
    const cellP = cell?.p ?? 0;
    const cellLead = cell?.lead ?? 0;
    result[index] = {
      row: row?.row ?? slot.output.value,
      cell: cellP,
      rowVLead: rowLead,
      cellVLead: cellLead,
      vLead: rowLead + cellLead,
      settled: (row?.settled ?? true) && cellP === 0,
    };
  }
  const cells = batch?.cells || simple.cells;
  for (const key in cells) {
    const index = Number(key);
    if (result[index]) continue;
    const cell = cells[index];
    result[index] = {
      row: 0,
      cell: cell.p,
      rowVLead: 0,
      cellVLead: cell.lead,
      vLead: cell.lead,
      settled: cell.settled,
    };
  }
  return result;
}
