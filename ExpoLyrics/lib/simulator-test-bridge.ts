// Dev/test-only communication bridge for observing real native renderer readiness and layout
// Excluded from production builds by compile-time __DEV__ check

export type RendererReadyEvent = {
  key: string;
  generation: number;
  style: string;
  linesCount: number;
  trackId: string | null;
  timestamp: number;
};

export type LayoutChangeEvent = {
  width: number;
  height: number;
  windowWidth?: number;
  windowHeight?: number;
  orientation: 'portrait' | 'landscape';
  style: string;
  timestamp: number;
};

type ReadyWaiter = {
  style?: string;
  trackId?: string;
  minGeneration?: number;
  resolve: (event: RendererReadyEvent) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

type LayoutWaiter = {
  orientation: 'portrait' | 'landscape';
  resolve: (event: LayoutChangeEvent) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

let latestReadyEvent: RendererReadyEvent | null = null;
let latestLayoutEvent: LayoutChangeEvent | null = null;
const readyWaiters: Set<ReadyWaiter> = new Set();
const layoutWaiters: Set<LayoutWaiter> = new Set();

export function isSimulatorTestActive(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ && process.env.EXPO_PUBLIC_SIMULATOR_TEST === '1';
}

export function notifySimulatorRendererReady(data: {
  key: string;
  generation: number;
  style: string;
  linesCount: number;
  trackId: string | null;
}): void {
  if (!isSimulatorTestActive()) return;

  const event: RendererReadyEvent = {
    ...data,
    timestamp: Date.now(),
  };
  latestReadyEvent = event;

  console.info(`[KINESYNC_SIM] RENDERER_ACTIVE style=${data.style} generation=${data.generation} lines=${data.linesCount} track=${data.trackId}`);

  for (const waiter of Array.from(readyWaiters)) {
    const styleMatches = !waiter.style || waiter.style === data.style;
    const trackMatches = !waiter.trackId || waiter.trackId === data.trackId;
    const genMatches = waiter.minGeneration === undefined || data.generation >= waiter.minGeneration;
    const hasLyrics = data.linesCount > 0;
    if (styleMatches && trackMatches && genMatches && hasLyrics) {
      clearTimeout(waiter.timeoutHandle);
      readyWaiters.delete(waiter);
      waiter.resolve(event);
    }
  }
}

export function notifySimulatorLayout(data: {
  width: number;
  height: number;
  windowWidth?: number;
  windowHeight?: number;
  style: string;
}): void {
  if (!isSimulatorTestActive()) return;

  const isLandscape = data.width > data.height && (!data.windowWidth || data.windowWidth > (data.windowHeight ?? 0));
  const orientation: 'portrait' | 'landscape' = isLandscape ? 'landscape' : 'portrait';
  const event: LayoutChangeEvent = {
    ...data,
    orientation,
    timestamp: Date.now(),
  };
  latestLayoutEvent = event;

  console.info(`[KINESYNC_SIM] VIEWPORT_LAYOUT width=${Math.round(data.width)} height=${Math.round(data.height)} windowWidth=${Math.round(data.windowWidth || 0)} windowHeight=${Math.round(data.windowHeight || 0)} orientation=${orientation} style=${data.style}`);

  for (const waiter of Array.from(layoutWaiters)) {
    if (waiter.orientation === orientation) {
      clearTimeout(waiter.timeoutHandle);
      layoutWaiters.delete(waiter);
      waiter.resolve(event);
    }
  }
}

export function waitForSimulatorRendererReady(
  options: { style?: string; trackId?: string; minGeneration?: number; timeoutMs?: number } = {}
): Promise<RendererReadyEvent> {
  if (!isSimulatorTestActive()) {
    return Promise.reject(new Error('Simulator test mode is not active'));
  }

  const { style, trackId, minGeneration, timeoutMs = 12000 } = options;

  if (latestReadyEvent) {
    const styleMatches = !style || latestReadyEvent.style === style;
    const trackMatches = !trackId || latestReadyEvent.trackId === trackId;
    const genMatches = minGeneration === undefined || latestReadyEvent.generation >= minGeneration;
    const hasLyrics = latestReadyEvent.linesCount > 0;
    if (styleMatches && trackMatches && genMatches && hasLyrics) {
      return Promise.resolve(latestReadyEvent);
    }
  }

  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      readyWaiters.delete(waiter);
      reject(new Error(`TIMEOUT_WAITING_RENDERER_READY style=${style ?? 'any'} track=${trackId ?? 'any'} minGen=${minGeneration ?? 'any'} timeoutMs=${timeoutMs}`));
    }, timeoutMs);

    const waiter: ReadyWaiter = {
      style,
      trackId,
      minGeneration,
      resolve,
      reject,
      timeoutHandle,
    };
    readyWaiters.add(waiter);
  });
}

export function waitForSimulatorOrientation(
  orientation: 'portrait' | 'landscape',
  timeoutMs: number = 12000
): Promise<LayoutChangeEvent> {
  if (!isSimulatorTestActive()) {
    return Promise.reject(new Error('Simulator test mode is not active'));
  }

  if (latestLayoutEvent && latestLayoutEvent.orientation === orientation) {
    return Promise.resolve(latestLayoutEvent);
  }

  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      layoutWaiters.delete(waiter);
      reject(new Error(`TIMEOUT_WAITING_VIEWPORT_ROTATION expected=${orientation} timeoutMs=${timeoutMs}`));
    }, timeoutMs);

    const waiter: LayoutWaiter = {
      orientation,
      resolve,
      reject,
      timeoutHandle,
    };
    layoutWaiters.add(waiter);
  });
}

export async function waitForSimulatorScreenshotAck(
  stage: string,
  timeoutMs: number = 12000
): Promise<void> {
  if (!isSimulatorTestActive()) {
    return Promise.reject(new Error('Simulator test mode is not active'));
  }

  let FileClass: typeof import('expo-file-system').File | null = null;
  let PathsClass: typeof import('expo-file-system').Paths | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-file-system') as typeof import('expo-file-system');
    FileClass = mod.File;
    PathsClass = mod.Paths;
  } catch {
    FileClass = null;
    PathsClass = null;
  }

  if (!FileClass || !PathsClass || !PathsClass.cache) {
    console.info(`[KINESYNC_SIM] SCREENSHOT_ACK_FALLBACK stage=${stage}`);
    await new Promise((r) => setTimeout(r, 200));
    return;
  }

  const ackFileName = `kinesync_sim_ack_${stage}.json`;
  const file = new FileClass(PathsClass.cache, ackFileName);

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      if (file.exists) {
        try {
          file.delete();
        } catch {
          // ignore cleanup error
        }
        console.info(`[KINESYNC_SIM] SCREENSHOT_ACK_RECEIVED stage=${stage} latencyMs=${Date.now() - startTime}`);
        return;
      }
    } catch {
      // transient read failure
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(`TIMEOUT_WAITING_SCREENSHOT_ACK stage=${stage} timeoutMs=${timeoutMs}`);
}

export function getLatestRendererReadyEvent(): RendererReadyEvent | null {
  return latestReadyEvent;
}

export function getLatestLayoutEvent(): LayoutChangeEvent | null {
  return latestLayoutEvent;
}

export function resetSimulatorBridge(): void {
  for (const waiter of readyWaiters) {
    clearTimeout(waiter.timeoutHandle);
    waiter.reject(new Error('CANCELLED'));
  }
  readyWaiters.clear();

  for (const waiter of layoutWaiters) {
    clearTimeout(waiter.timeoutHandle);
    waiter.reject(new Error('CANCELLED'));
  }
  layoutWaiters.clear();

  latestReadyEvent = null;
  latestLayoutEvent = null;
}
