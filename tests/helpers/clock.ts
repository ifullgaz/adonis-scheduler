type TimerHandlerFn = (...args: unknown[]) => unknown

type Timer = {
  id: number
  fn: TimerHandlerFn
  time: number
  interval: number | null
  cleared: boolean
}

type TimerHandle = {
  id: number
  ref: () => TimerHandle
  unref: () => TimerHandle
  hasRef: () => boolean
  refresh: () => TimerHandle
}

type ClockState = {
  now: number
  timers: Timer[]
  nextId: number
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
}

export type Clock = {
  now: () => number
  advance: (ms: number) => Promise<void>
  timeoutDelays: () => number[]
  intervalDelays: () => number[]
}

/**
 * Owns delayed timers and Date so a scheduler tick can run without waiting for
 * a real minute. Zero-delay timers stay on the real event loop so other
 * libraries can release locks.
 */
export async function withClock(start: string, run: (clock: Clock) => Promise<void>) {
  const state: ClockState = {
    now: Date.parse(start),
    timers: [],
    nextId: 1,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }
  const restore = install(state)
  const clock: Clock = {
    now: () => state.now,
    advance: (ms) => advance(state, ms),
    timeoutDelays: () => delays(state, false),
    intervalDelays: () => delays(state, true),
  }

  try {
    await run(clock)
  } finally {
    restore()
  }
}

function install(state: ClockState) {
  const OriginalDate = globalThis.Date

  function ClockDate(this: Date, ...args: unknown[]) {
    if (!new.target) {
      return new OriginalDate(state.now).toString()
    }
    if (args.length === 0) {
      return new OriginalDate(state.now)
    }
    return new OriginalDate(...(args as ConstructorParameters<DateConstructor>))
  }

  ClockDate.prototype = OriginalDate.prototype
  ClockDate.now = () => state.now
  ClockDate.parse = OriginalDate.parse
  ClockDate.UTC = OriginalDate.UTC
  globalThis.Date = ClockDate as DateConstructor

  globalThis.setTimeout = ((fn: TimerHandlerFn, ms?: number) => {
    return schedule(state, fn, ms, null)
  }) as typeof globalThis.setTimeout
  globalThis.setInterval = ((fn: TimerHandlerFn, ms?: number) => {
    const delay = normalizeDelay(ms)
    return schedule(state, fn, delay, delay)
  }) as typeof globalThis.setInterval
  globalThis.clearTimeout = ((handle?: TimerHandle) => {
    clear(state, handle, state.clearTimeout)
  }) as typeof globalThis.clearTimeout
  globalThis.clearInterval = ((handle?: TimerHandle) => {
    clear(state, handle, state.clearInterval)
  }) as typeof globalThis.clearInterval

  return () => {
    globalThis.Date = OriginalDate
    globalThis.setTimeout = state.setTimeout
    globalThis.clearTimeout = state.clearTimeout
    globalThis.setInterval = state.setInterval
    globalThis.clearInterval = state.clearInterval
  }
}

function schedule(
  state: ClockState,
  fn: TimerHandlerFn,
  ms: number | undefined,
  interval: number | null
) {
  const delay = normalizeDelay(ms)
  if (interval === null && delay === 0) {
    return state.setTimeout(fn as () => void, 0)
  }
  const id = state.nextId++
  const handle = createHandle(id)
  state.timers.push({
    id,
    fn: typeof fn === 'function' ? fn : () => undefined,
    time: state.now + delay,
    interval,
    cleared: false,
  })
  return handle as unknown as ReturnType<typeof setTimeout>
}

function createHandle(id: number): TimerHandle {
  const handle: TimerHandle = {
    id,
    ref: () => handle,
    unref: () => handle,
    hasRef: () => true,
    refresh: () => handle,
  }
  return handle
}

function clear(
  state: ClockState,
  handle: TimerHandle | undefined,
  original: typeof globalThis.clearTimeout
) {
  const timer = state.timers.find((item) => item.id === handle?.id)
  if (timer) {
    timer.cleared = true
    return
  }
  original(handle as unknown as Parameters<typeof clearTimeout>[0])
}

async function advance(state: ClockState, ms: number) {
  const target = state.now + ms
  while (true) {
    const next = state.timers
      .filter((timer) => !timer.cleared && timer.time <= target)
      .sort((left, right) => left.time - right.time || left.id - right.id)[0]
    if (!next) {
      break
    }
    state.now = next.time
    if (next.interval === null) {
      next.cleared = true
    } else {
      next.time += next.interval
    }
    await next.fn()
  }
  state.now = target
}

function delays(state: ClockState, interval: boolean) {
  return state.timers
    .filter((timer) => !timer.cleared && (timer.interval !== null) === interval)
    .map((timer) => (interval ? timer.interval || 0 : timer.time - state.now))
}

function normalizeDelay(ms: number | undefined) {
  if (ms === undefined || ms < 0) {
    return 0
  }
  return ms
}
