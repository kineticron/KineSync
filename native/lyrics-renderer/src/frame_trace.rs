//! Development device trace, enabled by Cargo feature and per-surface opt-in.
//! Compare the same clip with capture off, capture on and panel hidden, then
//! capture on and panel visible. Pin lyrics, translation setting and gesture.
//! CPU present entry stamps never observe display; GPU timestamps bracket
//! queue work from both Vello renders through the surface blit and include
//! gaps between submissions. Physical scanout is outside both scopes.

use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Instant,
};
use wgpu::{
    Buffer, BufferDescriptor, BufferUsages, CommandEncoder, Device, MapMode, QuerySet,
    QuerySetDescriptor, QueryType,
};

pub(crate) const WINDOW_MS: f64 = 5000.0;
pub(crate) const MAX_EXPORT_BYTES: usize = 512 * 1024;
const MAX_RECORDS: usize = 1200;
pub(crate) const GPU_SLOTS: usize = 4;

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capture {
    pub token: u64,
    pub generation: u64,
    pub surface: u64,
    pub started_ms: f64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrameKey {
    session: u64,
    frame: u64,
}

#[derive(Clone, Copy)]
pub(crate) struct Request {
    pub id: u64,
    pub segment: u64,
    pub worker_ms: f64,
    pub started: Instant,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Frame {
    #[serde(skip)]
    key: FrameKey,
    id: u64,
    segment: u64,
    worker_ms: f64,
    finished_ms: f64,
    status: i32,
    acquire_attempts: u8,
    acquire_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    encode_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    present_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gpu: Option<GpuSample>,
    bookkeeping_ms: f64,
    marker_cpu_ms: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuSample {
    elapsed_ms: f64,
    collected_ms: f64,
}

pub(crate) struct Attempt {
    started: Instant,
    frame: Frame,
}

impl Attempt {
    fn new(request: Request, key: FrameKey) -> Self {
        Self {
            started: request.started,
            frame: Frame {
                key,
                id: request.id,
                segment: request.segment,
                worker_ms: request.worker_ms,
                finished_ms: request.worker_ms,
                status: -1,
                acquire_attempts: 0,
                acquire_ms: 0.0,
                encode_ms: None,
                present_ms: None,
                gpu: None,
                bookkeeping_ms: 0.0,
                marker_cpu_ms: 0.0,
            },
        }
    }

    pub(crate) fn key(&self) -> FrameKey {
        self.frame.key
    }

    pub(crate) fn now_ms(&self) -> f64 {
        self.frame.worker_ms + milliseconds(self.started)
    }

    pub(crate) fn acquire(&mut self, ms: f64) {
        let started = Instant::now();
        self.frame.acquire_attempts = self.frame.acquire_attempts.saturating_add(1);
        self.frame.acquire_ms += ms;
        self.frame.bookkeeping_ms += milliseconds(started);
    }

    pub(crate) fn present(&mut self, encode_ms: f64, at: Instant) {
        let started = Instant::now();
        self.frame.encode_ms = Some(encode_ms);
        self.frame.present_ms =
            Some(self.frame.worker_ms + at.duration_since(self.started).as_secs_f64() * 1000.0);
        self.frame.bookkeeping_ms += milliseconds(started);
    }

    pub(crate) fn marker_cpu(&mut self, started: Instant) {
        self.frame.marker_cpu_ms += milliseconds(started);
    }
}

#[derive(Default)]
pub(crate) struct Trace {
    capture: Capture,
    session: u64,
    next_frame: u64,
    frames: VecDeque<Frame>,
    overwritten: u64,
    gpu_slots_full: u64,
    gpu_readback_failed: u64,
    gpu_late: u64,
    collect_cpu_ms: f64,
    snapshot_cpu_ms: f64,
    pub(crate) attempt: Option<Attempt>,
}

impl Trace {
    pub(crate) fn new(capture: Capture, session: u64) -> Self {
        Self {
            capture,
            session,
            frames: VecDeque::with_capacity(MAX_RECORDS),
            ..Self::default()
        }
    }

    pub(crate) fn begin(&mut self, request: Request) {
        self.next_frame += 1;
        self.attempt = Some(Attempt::new(
            request,
            FrameKey {
                session: self.session,
                frame: self.next_frame,
            },
        ));
    }

    pub(crate) fn finish(&mut self, status: i32) {
        let started = Instant::now();
        let Some(mut attempt) = self.attempt.take() else {
            return;
        };
        if self.frames.len() == MAX_RECORDS {
            self.frames.pop_front();
            self.overwritten += 1;
        }
        attempt.frame.status = status;
        attempt.frame.finished_ms = attempt.now_ms();
        attempt.frame.bookkeeping_ms += milliseconds(started);
        self.frames.push_back(attempt.frame);
    }

    pub(crate) fn gpu_slot_full(&mut self) {
        self.gpu_slots_full += 1;
    }

    pub(crate) fn collect_gpu(&mut self, slots: &mut [GpuSlot], now_ms: f64, period_ns: f32) {
        let started = Instant::now();
        for slot in slots {
            let Some((key, value)) = slot.collect(period_ns) else {
                continue;
            };
            self.record_gpu(key, value, now_ms);
        }
        self.collect_cpu_ms += milliseconds(started);
    }

    fn record_gpu(&mut self, key: FrameKey, value: Option<f64>, now_ms: f64) {
        if key.session != self.session {
            return;
        }
        if value.is_none() {
            self.gpu_readback_failed += 1;
        }
        if let Some(frame) = self.frames.iter_mut().rev().find(|frame| frame.key == key) {
            frame.gpu = value.map(|elapsed_ms| GpuSample {
                elapsed_ms,
                collected_ms: now_ms,
            });
        } else {
            self.gpu_late += 1;
        }
    }

    pub(crate) fn snapshot(
        &mut self,
        now_ms: f64,
        segment: u64,
        export: bool,
        gpu_unavailable: Option<&'static str>,
    ) -> Result<Vec<u8>, serde_json::Error> {
        let started = Instant::now();
        // A draw may run ahead of a snapshot whose cutoff was frozen on main.
        // Apply the time window without modifying the capacity-bounded history.
        let earliest_ms = now_ms - WINDOW_MS;
        let frames = || {
            self.frames
                .iter()
                .filter(|frame| frame.worker_ms >= earliest_ms && frame.finished_ms <= now_ms)
        };
        let active = || frames().filter(|frame| segment != 0 && frame.segment == segment);
        let mut last_present = None;
        let mut present_intervals = Vec::new();
        let mut gpu_ms = Vec::new();
        let mut latest_gpu = None;
        let mut capacity = 0;
        let mut no_drawable = 0;
        let mut awaiting_input = 0;
        let mut failed = 0;
        let mut present_count = 0;
        for frame in frames() {
            match frame.status {
                3 => capacity += 1,
                2 => no_drawable += 1,
                1 => awaiting_input += 1,
                -1 => failed += 1,
                _ => {}
            }
            present_count += usize::from(frame.present_ms.is_some());
        }
        for frame in active() {
            if let Some(at) = frame.present_ms {
                if let Some(previous) = last_present.filter(|previous| at > *previous) {
                    present_intervals.push(at - previous);
                }
                last_present = Some(at);
            }
            if let Some(sample) = &frame.gpu
                && sample.collected_ms <= now_ms
            {
                gpu_ms.push(sample.elapsed_ms);
                latest_gpu = Some((frame, sample));
            }
        }
        let latest_gpu = latest_gpu.map(|(frame, sample)| {
            serde_json::json!({
                "frameId": frame.id,
                "ageMs": (now_ms - frame.worker_ms).max(0.0),
                "readbackLatencyMs": (sample.collected_ms - frame.worker_ms).max(0.0),
            })
        });
        let present_hz = (!present_intervals.is_empty()).then(|| {
            1000.0 * present_intervals.len() as f64 / present_intervals.iter().sum::<f64>()
        });
        let window_ms = (now_ms - self.capture.started_ms).clamp(0.0, WINDOW_MS);
        let summary = serde_json::json!({
            "windowMs": window_ms,
            "activePresentCallHz": present_hz,
            "windowPresentCallHz": (window_ms > 0.0).then(|| present_count as f64 * 1000.0 / window_ms),
            "presentIntervalMs": Distribution::of(present_intervals),
            "encodeMs": Distribution::of(active().filter_map(|f| f.encode_ms).collect()),
            "acquireMs": Distribution::of(frames().filter(|f| f.acquire_attempts > 0).map(|f| f.acquire_ms).collect()),
            "gpuMs": Distribution::of(gpu_ms),
            "gpuUnavailable": gpu_unavailable,
            "latestGpu": latest_gpu,
            "drawableUnavailable": "Drawable presentedTime is not instrumented in this build.",
            "nativeBookkeepingMs": Distribution::of(frames().map(|f| f.bookkeeping_ms).collect()),
            "gpuMarkerCpuMs": Distribution::of(frames().filter(|f| f.marker_cpu_ms > 0.0).map(|f| f.marker_cpu_ms).collect()),
            "collectCpuMsTotal": self.collect_cpu_ms,
            "previousSnapshotCpuMs": self.snapshot_cpu_ms,
            "capacitySkips": capacity,
            "noDrawable": no_drawable,
            "awaitingInput": awaiting_input,
            "failed": failed,
            "overwritten": self.overwritten,
            "gpuSlotsFull": self.gpu_slots_full,
            "gpuReadbackFailed": self.gpu_readback_failed,
            "gpuLate": self.gpu_late,
        });
        #[derive(Serialize)]
        struct Snapshot {
            capture: Capture,
            summary: serde_json::Value,
            #[serde(skip_serializing_if = "Option::is_none")]
            frames: Option<Vec<Frame>>,
        }
        let result = serde_json::to_vec(&Snapshot {
            capture: self.capture,
            summary,
            frames: export.then(|| {
                frames()
                    .cloned()
                    .map(|mut frame| {
                        frame.gpu = frame.gpu.filter(|sample| sample.collected_ms <= now_ms);
                        frame
                    })
                    .collect()
            }),
        });
        self.snapshot_cpu_ms = milliseconds(started);
        result
    }
}

#[derive(Serialize)]
struct Distribution {
    count: usize,
    p50: f64,
    p95: f64,
    worst: f64,
}

impl Distribution {
    fn of(mut values: Vec<f64>) -> Option<Self> {
        values.sort_unstable_by(f64::total_cmp);
        let count = values.len();
        Some(Self {
            count,
            p50: *values.get(count.div_ceil(2).saturating_sub(1))?,
            p95: values[(count * 95).div_ceil(100) - 1],
            worst: values[count - 1],
        })
    }
}

pub(crate) struct GpuSlot {
    queries: QuerySet,
    resolve: Buffer,
    readback: Buffer,
    mapped_key: Option<FrameKey>,
    map_state: Arc<AtomicU8>,
}

impl GpuSlot {
    pub(crate) fn pool(device: &Device) -> [Self; GPU_SLOTS] {
        std::array::from_fn(|_| Self {
            queries: device.create_query_set(&QuerySetDescriptor {
                label: Some("live trace GPU interval"),
                ty: QueryType::Timestamp,
                count: 2,
            }),
            resolve: device.create_buffer(&BufferDescriptor {
                label: Some("live trace timestamp resolve"),
                size: 16,
                usage: BufferUsages::QUERY_RESOLVE
                    | BufferUsages::COPY_SRC
                    | BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            readback: device.create_buffer(&BufferDescriptor {
                label: Some("live trace timestamp readback"),
                size: 16,
                usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
                mapped_at_creation: false,
            }),
            mapped_key: None,
            map_state: Arc::new(AtomicU8::new(0)),
        })
    }

    pub(crate) fn free(&self) -> bool {
        self.mapped_key.is_none()
    }

    pub(crate) fn start(&self, encoder: &mut CommandEncoder) {
        encoder.write_timestamp(&self.queries, 0);
        // Give Metal a real blit operation to anchor a standalone timestamp.
        // The resolve overwrites these bytes at the end of the interval.
        encoder.clear_buffer(&self.resolve, 0, Some(4));
    }

    pub(crate) fn end(&self, encoder: &mut CommandEncoder) {
        encoder.write_timestamp(&self.queries, 1);
        // The resolve can split the encoder. Anchor this marker before it does.
        encoder.clear_buffer(&self.resolve, 0, Some(4));
        encoder.resolve_query_set(&self.queries, 0..2, &self.resolve, 0);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.readback, 0, 16);
    }

    pub(crate) fn map(&mut self, key: FrameKey) {
        let state = self.map_state.clone();
        state.store(0, Ordering::Relaxed);
        self.mapped_key = Some(key);
        self.readback.map_async(MapMode::Read, .., move |result| {
            state.store(if result.is_ok() { 1 } else { 2 }, Ordering::Release);
        });
    }

    fn collect(&mut self, period_ns: f32) -> Option<(FrameKey, Option<f64>)> {
        let key = self.mapped_key?;
        let state = self.map_state.load(Ordering::Acquire);
        if state == 0 {
            return None;
        }
        let value = if state == 1 {
            let value = self
                .readback
                .slice(..)
                .get_mapped_range()
                .ok()
                .and_then(|data| {
                    let start = u64::from_ne_bytes(data.get(..8)?.try_into().ok()?);
                    let end = u64::from_ne_bytes(data.get(8..16)?.try_into().ok()?);
                    (start != 0 && end != u64::MAX && end > start && period_ns > 0.0)
                        .then(|| (end - start) as f64 * f64::from(period_ns) / 1_000_000.0)
                });
            self.readback.unmap();
            value
        } else {
            None
        };
        self.mapped_key = None;
        Some((key, value))
    }
}

pub(crate) fn milliseconds(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_bound_expiry_and_segment_boundary() {
        let mut trace = Trace::new(Capture::default(), 1);
        for id in 1..=1202 {
            trace.begin(Request {
                id,
                segment: 1 + id / 1000,
                worker_ms: id as f64 * 2.0,
                started: Instant::now(),
            });
            let attempt = trace.attempt.as_mut().unwrap();
            attempt.frame.present_ms = Some(attempt.frame.worker_ms);
            trace.finish(0);
        }
        let data = trace.snapshot(2500.0, 2, true, None).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&data).unwrap();
        assert!(data.len() < MAX_EXPORT_BYTES);
        assert_eq!(json["summary"]["overwritten"], 2);
        assert_eq!(json["summary"]["presentIntervalMs"]["count"], 202);
        assert_eq!(json["summary"]["presentIntervalMs"]["p95"], 2.0);
        assert_eq!(json["frames"].as_array().unwrap().len(), MAX_RECORDS);
        let late: serde_json::Value =
            serde_json::from_slice(&trace.snapshot(8000.0, 0, true, None).unwrap()).unwrap();
        assert!(late["frames"].as_array().unwrap().is_empty());
        assert_eq!(trace.frames.len(), MAX_RECORDS);
    }

    #[test]
    fn newer_draw_does_not_erase_records_for_a_queued_cutoff() {
        let mut trace = Trace::new(Capture::default(), 1);
        for (id, worker_ms) in [(1, 8.0), (2, 6000.0)] {
            trace.begin(Request {
                id,
                segment: 1,
                worker_ms,
                started: Instant::now(),
            });
            trace.finish(0);
            trace.frames.back_mut().unwrap().finished_ms = worker_ms + 1.0;
        }
        for (cutoff, expected_id) in [(6010.0, 2), (80.0, 1)] {
            let data = trace.snapshot(cutoff, 1, true, None).unwrap();
            let json: serde_json::Value = serde_json::from_slice(&data).unwrap();
            let frames = json["frames"].as_array().unwrap();
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0]["id"], expected_id);
            assert_eq!(json["summary"]["overwritten"], 0);
        }
    }

    #[test]
    fn capacity_and_drawable_retries_do_not_count_as_present_calls() {
        let mut trace = Trace::new(Capture::default(), 1);
        for (id, status) in [(1, 0), (2, 3), (3, 2), (4, 0)] {
            let worker_ms = id as f64 * 8.0;
            trace.begin(Request {
                id,
                segment: 1,
                worker_ms,
                started: Instant::now(),
            });
            let attempt = trace.attempt.as_mut().unwrap();
            if status == 0 {
                attempt.frame.present_ms = Some(worker_ms);
            }
            trace.finish(status);
        }
        let data = trace
            .snapshot(100.0, 1, false, Some("Unsupported"))
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&data).unwrap();
        assert_eq!(json["summary"]["capacitySkips"], 1);
        assert_eq!(json["summary"]["noDrawable"], 1);
        assert_eq!(json["summary"]["presentIntervalMs"]["count"], 1);
        assert_eq!(json["summary"]["presentIntervalMs"]["p95"], 24.0);
        assert_eq!(json["summary"]["gpuUnavailable"], "Unsupported");
        assert!(json.get("frames").is_none());
        let idle: serde_json::Value =
            serde_json::from_slice(&trace.snapshot(100.0, 0, false, None).unwrap()).unwrap();
        assert!(idle["summary"]["activePresentCallHz"].is_null());
        assert_eq!(idle["summary"]["windowPresentCallHz"], 20.0);
    }

    #[test]
    fn delayed_gpu_result_cannot_match_reused_public_ids_or_cross_cutoff() {
        let request = Request {
            id: 7,
            segment: 1,
            worker_ms: 8.0,
            started: Instant::now(),
        };
        let mut trace = Trace::new(Capture::default(), 2);
        trace.begin(request);
        let key = trace.attempt.as_ref().unwrap().key();
        trace.finish(0);
        let old = FrameKey {
            session: 1,
            frame: 1,
        };
        trace.record_gpu(old, None, 90.0);
        trace.record_gpu(old, Some(1.0), 90.0);
        assert!(trace.frames[0].gpu.is_none());
        assert_eq!((trace.gpu_late, trace.gpu_readback_failed), (0, 0));
        trace.record_gpu(key, Some(2.0), 90.0);
        let summary: serde_json::Value =
            serde_json::from_slice(&trace.snapshot(80.0, 1, true, None).unwrap()).unwrap();
        assert!(summary["summary"]["gpuMs"].is_null());
        assert!(summary["frames"][0].get("gpu").is_none());
        let summary: serde_json::Value =
            serde_json::from_slice(&trace.snapshot(100.0, 1, true, None).unwrap()).unwrap();
        assert_eq!(summary["summary"]["gpuMs"]["p95"], 2.0);
        assert_eq!(summary["frames"][0]["gpu"]["elapsedMs"], 2.0);
    }
}
