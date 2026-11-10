import type { SharedValue } from 'react-native-reanimated';
import { amllScrollSpring, stepAmllSpring } from './reference-motion';
import type { ReferenceScroll, RowMotionEntry, ScrollCommand } from './reference-scroll';

type RowState = { p: number; v: number; renderedP: number; delay: number; prevResidual: number; stiffness: number; damping: number };
type RowSlot = { state: SharedValue<RowState>; output: SharedValue<number>; sleeping: boolean; command: ScrollCommand };
type CellSlot = { owner: Readonly<{ value: unknown }>; p: number; lead: number; settled: boolean };
export type BatchedMotion = { rows: Record<number, RowSlot>; cells: Record<number, CellSlot>; dirty: boolean; awake?: boolean; command?: ScrollCommand };

// Declarations prevent worklet capture of uninitialized helpers. Imports back
// into reference-scroll are type-only, so there is no runtime import cycle.
export function removeBatchedMotion(batch: SharedValue<BatchedMotion>, index: number, owner: Readonly<{ value: unknown }>, cell: boolean) {
  'worklet';
  batch.modify(value => {
    if (cell ? value.cells[index]?.owner === owner : value.rows[index]?.output === owner) {
      if (cell) delete value.cells[index];
      else delete value.rows[index];
      value.dirty = true;
    }
    return value;
  });
}

export function stageBatchedCell(host: ReferenceScroll, index: number, owner: Readonly<{ value: unknown }>, p: number, lead: number, settled: boolean) {
  'worklet';
  if ((owner.value as { index: number }).index !== index) return;
  host.batch!.modify(value => {
    value.cells[index] = { owner, p, lead, settled };
    value.dirty = true;
    return value;
  });
}

export function prepareBatchedRow(host: ReferenceScroll, index: number, enabled: boolean, state: SharedValue<RowState>, output: SharedValue<number>, command: ScrollCommand,
  previous: { command: ScrollCommand; index: number } | null) {
  'worklet';
  const batch = host.batch!;
  if (previous && previous.index !== index) removeBatchedMotion(batch, previous.index, output, false);
  if (!enabled) { removeBatchedMotion(batch, index, output, false); return; }
  if (!previous || previous.index !== index || !batch.value.rows[index]) {
    state.value = { ...state.value, p: host.residual.value, v: 0, renderedP: host.renderedResidual.value,
      delay: 0, prevResidual: host.renderedResidual.value };
    output.value = 0;
  } else if (command.serial === previous.command.serial) return;
  else if (command.instant) {
    state.value = { ...state.value, p: 0, v: 0, renderedP: 0, delay: 0, prevResidual: host.renderedResidual.value };
    output.value = 0;
  } else {
    const delta = command.geometry || previous.command.snap ? command.delta : command.offset - host.actualOffset.value;
    state.value = { ...state.value, p: state.value.p + delta,
      ...amllScrollSpring(command.geometry || previous.command.snap ? command : { ...command, firstVisible: command.index }, index),
      ...(command.geometry ? { delay: 0 } : {}), prevResidual: host.renderedResidual.value };
  }
  batch.modify(value => {
    value.rows[index] = { state, output, sleeping: false, command };
    value.awake = true;
    value.dirty = true;
    return value;
  });
}

/** One pass AFTER the viewport step. No row frame callbacks or global scans
 * per row. Row outputs are relative to that same frame's viewport residual. */
export function advanceBatchedMotion(host: ReferenceScroll, elapsed: number | null) {
  'worklet';
  const batch = host.batch!, residual = host.residual.value, rendered = host.renderedResidual.value;
  if (batch.value.awake === false && !batch.value.dirty && residual === 0) return;
  const dt = Math.min(0.064, Math.max(0, (elapsed ?? 0) / 1000)) || 1 / 60;
  const worstHost = stepAmllSpring({ p: residual, v: 0 }, 0, 0.9, 15, 90, 0.064);
  const previous = host.batchRows?.value ?? {};
  let changed = batch.value.dirty;
  const registry: Record<number, RowMotionEntry> = {};
  batch.modify(value => {
    value.awake = false;
    for (const key in value.rows) {
      const index = Number(key), slot = value.rows[index], s = slot.state.value;
      let p = s.p, v = s.v, delay = s.delay;
      const idle = p === 0 && v === 0 && s.renderedP === 0 && residual === 0;
      const hostLead = residual !== 0 ? Math.max(Math.abs(rendered - s.prevResidual), Math.abs(worstHost.p - residual), Math.abs(residual) * 0.45) : 0;
      let rowLead = 0, settled = idle;
      if (!slot.sleeping && !idle) {
        if (delay > 0) {
          delay = Math.max(0, delay - dt);
          const worst = stepAmllSpring({ p, v: 0 }, 0, 0.9, s.damping, s.stiffness, 0.064);
          rowLead = Math.abs(worst.p - p);
        } else {
          const next = stepAmllSpring(s, 0, 0.9, s.damping, s.stiffness, dt);
          // Preserve both baseline thresholds and the exact integration trajectory.
          settled = Math.abs(next.p) < 0.01 && Math.abs(next.v) < 0.01;
          p = settled ? 0 : next.p;
          v = settled ? 0 : next.v;
          const worst = stepAmllSpring(next, 0, 0.9, s.damping, s.stiffness, 0.064);
          rowLead = settled ? 0 : Math.max(Math.abs(worst.p - next.p), Math.abs(next.v) * 0.064, 0.01);
        }
        // Solver state is private to this coordinator. Retain exact subpixel
        // integration without notifying a mapper or allocating a row object.
        slot.state.modify(current => {
          current.p = p; current.v = v; current.renderedP = p;
          current.delay = delay; current.prevResidual = rendered;
          return current;
        }, false);
      }
      // A command replaces/wakes the slot. Sleeping rows still track a moving
      // viewport without executing their settled spring solver.
      slot.sleeping = settled && residual === 0;
      if (!slot.sleeping) value.awake = true;
      const exact = host.command.value.snap ? p - rendered : 0;
      // Compare accumulated movement with last emitted output; always emit zero.
      if (exact === 0 || Math.abs(exact - slot.output.value) >= 1e-7) slot.output.value = exact;
      const hidden = Math.abs(exact - slot.output.value);
      const rowVLead = (settled && residual === 0 ? 0 : rowLead + hostLead) + hidden;
      const cellP = 0, cellLead = 0;
      const entry: RowMotionEntry = { owner: slot.output, row: slot.output.value, cell: cellP, rowVLead, cellVLead: cellLead,
        vLead: rowVLead + cellLead, settled: settled && cellP === 0 };
      const old = previous[index], lead = entry.vLead ?? 0, oldLead = old?.vLead ?? 0;
      // A retained entry must contain the entire new envelope, including every
      // hidden small delta. Epsilon alone is NOT a safe blur invalidation gate.
      if (old && old.owner === slot.output && old.settled === entry.settled && Math.abs(old.row - entry.row) < 0.001 && Math.abs(old.cell - cellP) < 0.001 &&
        Math.abs(oldLead - lead) < 0.001 && old.row + old.cell - oldLead <= entry.row + cellP - lead &&
        old.row + old.cell + oldLead >= entry.row + cellP + lead) registry[index] = old;
      else { registry[index] = entry; changed = true; }
    }
    value.dirty = false;
    return value;
  }, false);
  if (changed && host.batchRows) host.batchRows.value = registry;
}

/** Native useDerivedValue runs once in the mapper finalizer after all rAFs.
 * Its declared output orders blur consumers after the merge. Cell animation
 * callbacks can precede OR follow the viewport callback without a stale mask. */
export function composeBatchedRegistry(rows: Record<number, RowMotionEntry>, batch: BatchedMotion): Record<number, RowMotionEntry> {
  'worklet';
  const result: Record<number, RowMotionEntry> = {};
  for (const key in batch.rows) {
    const index = Number(key), slot = batch.rows[index];
    // Output is current even on a recycle before the next viewport frame.
    const candidate = rows[index];
    const row = candidate?.owner === slot.output ? candidate : undefined;
    const rowLead = row ? row.rowVLead ?? 0 : Infinity, cell = batch.cells[index];
    const cellP = cell?.p ?? 0, cellLead = cell?.lead ?? 0;
    result[index] = { row: row?.row ?? slot.output.value, cell: cellP, rowVLead: rowLead,
      cellVLead: cellLead, vLead: rowLead + cellLead, settled: (row?.settled ?? true) && cellP === 0 };
  }
  for (const key in batch.cells) {
    const index = Number(key);
    if (result[index]) continue;
    const cell = batch.cells[index];
    result[index] = { row: 0, cell: cell.p, rowVLead: 0, cellVLead: cell.lead, vLead: cell.lead, settled: cell.settled };
  }
  return result;
}
