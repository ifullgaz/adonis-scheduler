import { test } from '@japa/runner'
import logger from '@adonisjs/core/services/logger'
import Schedule from '../src/model/schedule.js'
import type Scheduler from '../src/core/scheduler.js'
import type { SchedulerConfig } from '../src/types/types.js'
import { type Clock, withClock } from './helpers/clock.js'
import { RecordingJob } from './helpers/recording_job.js'
import {
  TEST_SCHEDULER_CONFIG,
  bindScheduler,
  getApp,
  getCache,
  getDatabase,
  getLocks,
  resetStorage,
} from './helpers/app.js'

const DUE_AT = '2026-11-19T15:30:10.250Z'
const MINUTE_DELAY = 49_750
const STATUS_RUNNING = 2
const STATUS_STOPPING = 3
const STATUS_TERMINATED = 4
let lockSequence = 0

test.group('Scheduler', (group) => {
  group.each.setup(async () => {
    await resetStorage()
  })

  test('starts once, arms the next minute, and stops once', async ({ assert }) => {
    const logs = captureLogger()
    try {
      await withScheduler(async (scheduler, clock) => {
        await scheduler.start()
        await scheduler.start()

        assert.equal(read(scheduler).status, STATUS_RUNNING)
        assert.deepEqual(clock.timeoutDelays(), [MINUTE_DELAY])
        assert.deepEqual(clock.intervalDelays(), [(TEST_SCHEDULER_CONFIG.lockTtl as number) * 500])
        assert.deepEqual(logs.texts('debug'), [
          '[Scheduler] Starting scheduler',
          '[Scheduler] Scheduler started',
          '[Scheduler] Scheduler already started',
        ])

        await clock.advance(MINUTE_DELAY - 1)
        assert.deepEqual(logs.texts('trace'), [
          `[Scheduler] Scheduler timeout set for ${MINUTE_DELAY}ms`,
        ])
        assert.deepEqual(clock.timeoutDelays(), [1])

        await scheduler.stop()
        await scheduler.stop()
        assert.deepEqual(clock.timeoutDelays(), [])
        assert.equal(read(scheduler).status, STATUS_TERMINATED)
        assert.deepEqual(logs.texts('debug').slice(3), [
          '[Scheduler] Stopping scheduler',
          '[Scheduler] Scheduler stopped',
          '[Scheduler] Scheduler already stopped',
        ])
      })
    } finally {
      logs.restore()
    }
  })

  test('uses the parsed lock ttl for the extend interval', async ({ assert }) => {
    await withScheduler({ lockTtl: '30s' }, async (scheduler, clock) => {
      await scheduler.start()
      assert.deepEqual(clock.intervalDelays(), [15_000])
    })
  })

  test('dispatches due schedules and skips inactive, invalid, and later minutes', async ({
    assert,
  }) => {
    const logs = captureLogger()
    try {
      await withScheduler(async (scheduler) => {
        await insert({ jobParams: { reportId: 1 } })
        await insert({ cronExpression: '0 * * * *', jobParams: { reportId: 2 } })
        const invalid = await insert({ cronExpression: 'not a cron', jobParams: { reportId: 3 } })
        await insert({ status: false, jobParams: { reportId: 4 } })
        await insert({ cronExpression: '30 15 * * 4', jobParams: { reportId: 5 } })
        await insert({ cronExpression: '30 15 * * 1', jobParams: { reportId: 6 } })

        await scheduler.start()
        await read(scheduler).scheduleTasks()

        assert.deepEqual(RecordingJob.scheduled.map(payload), [{ reportId: 1 }, { reportId: 5 }])
        assert.equal(await cachedVersion(), '1.0.0')
        assert.isTrue(
          logs
            .texts('error')
            .some((line) => line.startsWith(`[Scheduler] Cannot evaluate schedule ${invalid.id}:`))
        )
      })
    } finally {
      logs.restore()
    }
  })

  test('matches the cron minute in the schedule timezone', async ({ assert }) => {
    await withScheduler(async (scheduler) => {
      await insert({
        cronExpression: '30 10 * * *',
        tz: 'America/New_York',
        jobParams: { reportId: 'ny' },
      })
      await insert({
        cronExpression: '30 15 * * *',
        tz: 'America/New_York',
        jobParams: { reportId: 'ny-afternoon' },
      })
      await insert({
        cronExpression: '30 15 * * *',
        tz: 'UTC',
        jobParams: { reportId: 'utc' },
      })

      await scheduler.start()
      await read(scheduler).scheduleTasks()

      assert.deepEqual(RecordingJob.scheduled.map(payload), [
        { reportId: 'ny' },
        { reportId: 'utc' },
      ])
    })
  })

  test('caches schedules until the cache is cleared', async ({ assert }) => {
    await withScheduler(async (scheduler) => {
      await insert({ jobParams: { reportId: 1 } })
      await scheduler.start()
      await read(scheduler).scheduleTasks()

      const database = await getDatabase()
      await database.from('schedules').update({
        cron_expression: '0 * * * *',
        job_params: JSON.stringify({ reportId: 2 }),
      })
      await read(scheduler).scheduleTasks()
      await scheduler.clearCache()
      await read(scheduler).scheduleTasks()

      assert.deepEqual(RecordingJob.scheduled.map(payload), [{ reportId: 1 }, { reportId: 1 }])
    })
  })

  test('stores schedules for one day', async ({ assert }) => {
    await withScheduler(async (scheduler) => {
      await insert()
      const calls: Array<{ key: string; ttl?: number | null }> = []
      const cache = await getCache()
      const original = cache.getOrSet.bind(cache)
      cache.getOrSet = (async (options: Parameters<typeof original>[0]) => {
        calls.push({
          key: options.key,
          ttl: 'ttl' in options ? (options.ttl as number | null | undefined) : undefined,
        })
        return original(options)
      }) as typeof cache.getOrSet

      try {
        await scheduler.start()
        await read(scheduler).scheduleTasks()
      } finally {
        cache.getOrSet = original
      }

      assert.deepEqual(calls, [
        { key: TEST_SCHEDULER_CONFIG.versionKey, ttl: null },
        { key: TEST_SCHEDULER_CONFIG.cacheKey, ttl: 86_400_000 },
      ])
    })
  })

  test('does not run or take the lock when this version is older', async ({ assert }) => {
    const lockKey = 'scheduler:lock:older'
    await withScheduler({ lockKey }, async (scheduler) => {
      await insert()
      const cache = await getCache()
      await cache.set({ key: TEST_SCHEDULER_CONFIG.versionKey, value: '2.0.0' })
      getVersionConfig('1.0.0')

      await scheduler.start()
      await read(scheduler).scheduleTasks()

      assert.lengthOf(RecordingJob.scheduled, 0)
      assert.equal(await cachedVersion(), '2.0.0')
      const locks = await getLocks()
      const other = locks.createLock(lockKey, 60_000)
      assert.isTrue(await other.acquireImmediately())
      await other.release()
    })
  })

  test('stores a newer version and keeps the lock until stop', async ({ assert }) => {
    const lockKey = 'scheduler:lock:newer'
    await withScheduler({ lockKey }, async (scheduler) => {
      await insert({ jobParams: { reportId: 7 } })
      const cache = await getCache()
      await cache.set({ key: TEST_SCHEDULER_CONFIG.versionKey, value: '1.0.0' })
      getVersionConfig('1.2.0')

      await scheduler.start()
      await read(scheduler).scheduleTasks()

      assert.deepEqual(RecordingJob.scheduled.map(payload), [{ reportId: 7 }])
      assert.equal(await cachedVersion(), '1.2.0')

      const locks = await getLocks()
      const other = locks.createLock(lockKey, 60_000)
      assert.isFalse(await other.acquireImmediately())
      await scheduler.stop()
      assert.isTrue(await other.acquireImmediately())
      await other.release()
    })
  })

  test('leaves an equal cached version unchanged', async ({ assert }) => {
    await withScheduler(async (scheduler) => {
      await insert()
      const cache = await getCache()
      await cache.set({ key: TEST_SCHEDULER_CONFIG.versionKey, value: '1.0.0' })

      await scheduler.start()
      await read(scheduler).scheduleTasks()

      assert.lengthOf(RecordingJob.scheduled, 1)
      assert.equal(await cachedVersion(), '1.0.0')
    })
  })

  test('does not schedule when another process holds the lock', async ({ assert }) => {
    const lockKey = 'scheduler:lock:held'
    await withScheduler({ lockKey }, async (scheduler) => {
      await insert()
      const locks = await getLocks()
      const other = locks.createLock(lockKey, 60_000)
      assert.isTrue(await other.acquireImmediately())

      try {
        await scheduler.start()
        await read(scheduler).scheduleTasks()
        assert.lengthOf(RecordingJob.scheduled, 0)
      } finally {
        await other.release()
      }

      await read(scheduler).scheduleTasks()
      assert.lengthOf(RecordingJob.scheduled, 1)
    })
  })

  test('reports a missing job and continues after a job throws', async ({ assert }) => {
    const logs = captureLogger()
    try {
      await withScheduler(async (scheduler) => {
        await insert({ jobName: 'MissingJob', jobParams: { reportId: 1 } })
        await insert({ jobName: 'ExplodingJob', jobParams: { reportId: 2 } })
        await insert({ jobParams: { reportId: 3 } })

        await scheduler.start()
        await read(scheduler).scheduleTasks()

        assert.deepEqual(RecordingJob.scheduled.map(payload), [{ reportId: 3 }])
        assert.include(logs.texts('error'), '[Scheduler] Cannot find job MissingJob')
        assert.include(logs.texts('error'), '[Scheduler] Cannot schedule job ExplodingJob')
      })
    } finally {
      logs.restore()
    }
  })

  test('closes the database when the scheduler stops', async ({ assert }) => {
    const database = await getDatabase()
    const original = database.manager.closeAll
    let closed = 0
    database.manager.closeAll = async () => {
      closed += 1
    }

    try {
      await withScheduler(async (scheduler) => {
        await insert()
        await scheduler.start()
        await read(scheduler).scheduleTasks()
        await scheduler.stop()

        assert.equal(closed, 1)
        assert.lengthOf(RecordingJob.scheduled, 1)
        assert.equal(read(scheduler).status, STATUS_TERMINATED)
      })
    } finally {
      database.manager.closeAll = original
    }
  })

  test('dispatches a later wake after stop and does not close the database again', async ({
    assert,
  }) => {
    const database = await getDatabase()
    const original = database.manager.closeAll
    let closed = 0
    database.manager.closeAll = async () => {
      closed += 1
    }

    try {
      await withScheduler(async (scheduler) => {
        await insert()
        await scheduler.start()
        await scheduler.stop()
        await read(scheduler).scheduleTasks()

        assert.lengthOf(RecordingJob.scheduled, 1)
        assert.equal(closed, 1)
      })
    } finally {
      database.manager.closeAll = original
    }
  })

  test('runs the wake from the timer', async ({ assert }) => {
    await withScheduler(async (scheduler, clock) => {
      await insert({ jobParams: { reportId: 11 } })
      await scheduler.start()
      await clock.advance(MINUTE_DELAY)
      await waitUntil(() => RecordingJob.scheduled.length === 1, 'timer wake')

      assert.deepEqual(RecordingJob.scheduled.map(payload), [{ reportId: 11 }])
    })
  })

  test('runs the first wake immediately on a minute boundary and rearms for a full minute', async ({
    assert,
  }) => {
    const scheduler = await bindScheduler({
      lockKey: `scheduler:lock:${++lockSequence}`,
    })
    try {
      await withClock('2026-11-19T15:30:00.000Z', async (clock) => {
        try {
          await insert()
          await scheduler.start()
          await waitUntil(() => RecordingJob.scheduled.length === 1, 'boundary wake')

          assert.lengthOf(RecordingJob.scheduled, 1)
          assert.deepEqual(clock.timeoutDelays(), [60_000])
        } finally {
          await scheduler.stop()
        }
      })
    } finally {
      await scheduler.stop()
    }
  })

  test('does not rearm when stop waits on a wake that holds the stop lock', async ({ assert }) => {
    await withScheduler(async (scheduler, clock) => {
      await insert({ jobParams: { reportId: 'stop-race' } })
      let stopPromise: Promise<void> | undefined
      RecordingJob.beforeSchedule = async () => {
        stopPromise = scheduler.stop()
        await waitUntil(() => read(scheduler).status === STATUS_STOPPING, 'stop waiting on wake')
      }

      await scheduler.start()
      await read(scheduler).scheduleTasks()
      assert.isDefined(stopPromise)
      await stopPromise

      assert.deepEqual(RecordingJob.scheduled.map(payload), [{ reportId: 'stop-race' }])
      assert.equal(read(scheduler).status, STATUS_TERMINATED)
      assert.deepEqual(clock.timeoutDelays(), [])
    })
  })

  test('rearms after runImmediately throws while still running', async ({ assert }) => {
    const logs = captureLogger()
    try {
      await withScheduler(async (scheduler, clock) => {
        await scheduler.start()
        const internal = readInternals(scheduler)
        internal.stopLock.runImmediately = async () => {
          throw new Error('stop lock store down')
        }

        await read(scheduler).scheduleTasks()

        assert.include(
          logs.texts('error'),
          '[Scheduler] Scheduler tasks failed: stop lock store down'
        )
        assert.deepEqual(clock.timeoutDelays(), [MINUTE_DELAY])
        assert.equal(read(scheduler).status, STATUS_RUNNING)
      })
    } finally {
      logs.restore()
    }
  })

  test('does not replay a minute the process skipped', async ({ assert }) => {
    await withClock('2026-11-19T15:31:10.250Z', async () => {
      const scheduler = await bindScheduler({
        lockKey: `scheduler:lock:${++lockSequence}`,
      })
      try {
        await insert({
          cronExpression: '30 15 * * *',
          jobParams: { reportId: 'missed' },
        })
        await scheduler.start()
        await read(scheduler).scheduleTasks()
        assert.lengthOf(RecordingJob.scheduled, 0)
      } finally {
        await scheduler.stop()
      }
    })
  })

  test('does not match a six-field cron that is due mid-minute', async ({ assert }) => {
    await withScheduler(async (scheduler) => {
      await insert({
        cronExpression: '15 * * * * *',
        jobParams: { reportId: 'second-15' },
      })
      await scheduler.start()
      await read(scheduler).scheduleTasks()
      assert.lengthOf(RecordingJob.scheduled, 0)
    })
  })

  test('skips a spring-forward gap hour in the schedule timezone', async ({ assert }) => {
    // 2026-03-29 Europe/Paris: 02:00 → 03:00. Local 02:30 does not exist.
    await withClock('2026-03-29T01:30:10.250Z', async () => {
      const scheduler = await bindScheduler({
        lockKey: `scheduler:lock:${++lockSequence}`,
      })
      try {
        await insert({
          cronExpression: '30 2 * * *',
          tz: 'Europe/Paris',
          jobParams: { reportId: 'gap' },
        })
        await insert({
          cronExpression: '30 3 * * *',
          tz: 'Europe/Paris',
          jobParams: { reportId: 'after-gap' },
        })
        await scheduler.start()
        await read(scheduler).scheduleTasks()
        assert.deepEqual(RecordingJob.scheduled.map(payload), [{ reportId: 'after-gap' }])
      } finally {
        await scheduler.stop()
      }
    })
  })

  test('extends a held lock and skips the extend while the lock is free', async ({ assert }) => {
    const logs = captureLogger()
    try {
      await withScheduler({ lockTtl: '2s' }, async (scheduler, clock) => {
        await scheduler.start()
        await clock.advance(1_000)
        await readInternals(scheduler).extendLock()
        assert.deepEqual(logs.texts('error'), [])

        await insert()
        await read(scheduler).scheduleTasks()
        const lock = readInternals(scheduler).lock
        const extend = lock.extend
        let extended = 0
        lock.extend = async () => {
          extended += 1
          await extend.call(lock)
        }
        await readInternals(scheduler).extendLock()

        assert.equal(extended, 1)
        assert.deepEqual(logs.texts('error'), [])
      })
    } finally {
      logs.restore()
    }
  })

  test('releases the lock when it cannot be extended', async ({ assert }) => {
    const logs = captureLogger()
    try {
      await withScheduler(
        { lockKey: 'scheduler:lock:extend-release', lockTtl: '2s' },
        async (scheduler) => {
          await insert()
          await scheduler.start()
          await read(scheduler).scheduleTasks()
          const internal = readInternals(scheduler)
          const release = internal.lock.release
          let released = 0
          internal.lock.extend = async () => {
            throw new Error('extend failed')
          }
          internal.lock.release = async () => {
            released += 1
            await release.call(internal.lock)
          }
          await internal.extendLock()

          assert.equal(released, 1)
          assert.include(
            logs.texts('error'),
            '[Scheduler] Cannot extend lock scheduler:lock:extend-release: extend failed'
          )
          assert.isFalse(logs.texts('trace').some((text) => text.includes('was already released')))
        }
      )
    } finally {
      logs.restore()
    }
  })

  test('logs when the lock cannot be extended or released', async ({ assert }) => {
    const logs = captureLogger()
    try {
      await withScheduler(
        { lockKey: 'scheduler:lock:extend', lockTtl: '2s' },
        async (scheduler) => {
          await insert()
          await scheduler.start()
          await read(scheduler).scheduleTasks()
          const internal = readInternals(scheduler)
          internal.lock.extend = async () => {
            throw new Error('extend failed')
          }
          internal.lock.release = async () => {
            throw new Error('release failed')
          }
          await internal.extendLock()

          assert.include(
            logs.texts('error'),
            '[Scheduler] Cannot extend lock scheduler:lock:extend: extend failed'
          )
          assert.include(
            logs.texts('trace'),
            '[Scheduler] Lock scheduler:lock:extend was already released: release failed'
          )
        }
      )
    } finally {
      logs.restore()
    }
  })

  test('logs when the lock cannot be released while stopping', async ({ assert }) => {
    const logs = captureLogger()
    try {
      await withScheduler({ lockKey: 'scheduler:lock:release' }, async (scheduler) => {
        await insert()
        await scheduler.start()
        await read(scheduler).scheduleTasks()
        readInternals(scheduler).lock.release = async () => {
          throw new Error('release failed')
        }

        await readInternals(scheduler).releaseLock()
        await scheduler.stop()

        assert.include(
          logs.texts('error'),
          '[Scheduler] Cannot release lock scheduler:lock:release: release failed'
        )
        assert.equal(read(scheduler).status, STATUS_TERMINATED)
      })
    } finally {
      logs.restore()
    }
  })

  test('logs when closing the database fails', async ({ assert }) => {
    const logs = captureLogger()
    const database = await getDatabase()
    const original = database.manager.closeAll
    database.manager.closeAll = async () => {
      throw new Error('close failed')
    }

    try {
      await withScheduler(async (scheduler) => {
        await scheduler.start()
        await scheduler.stop()

        assert.include(
          logs.texts('error'),
          '[Scheduler] Cannot close database connections: close failed'
        )
        assert.equal(read(scheduler).status, STATUS_TERMINATED)
      })
    } finally {
      database.manager.closeAll = original
      logs.restore()
    }
  })

  test('logs a wake failure and arms the next minute', async ({ assert }) => {
    const logs = captureLogger()
    try {
      await withScheduler(async (scheduler, clock) => {
        await insert()
        const cache = await getCache()
        const original = cache.getOrSet.bind(cache)
        cache.getOrSet = (async () => {
          throw new Error('cache down')
        }) as typeof cache.getOrSet

        try {
          await scheduler.start()
          await read(scheduler).scheduleTasks()
        } finally {
          cache.getOrSet = original
        }

        assert.lengthOf(RecordingJob.scheduled, 0)
        assert.include(logs.texts('error'), '[Scheduler] Scheduler wake failed: cache down')
        assert.deepEqual(clock.timeoutDelays(), [MINUTE_DELAY])
      })
    } finally {
      logs.restore()
    }
  })

  test('schedules a JSON object payload and replaces values that are not objects', async ({
    assert,
  }) => {
    const scheduler = await bindScheduler()
    await scheduler.schedule('RecordingJob', '{"reportId":8}')
    await scheduler.schedule('RecordingJob', 'not-json')
    await scheduler.schedule('RecordingJob', '[1]')
    await scheduler.schedule('RecordingJob', 'null')
    await scheduler.schedule('RecordingJob', null)
    await scheduler.schedule('RecordingJob', 5)
    await scheduler.schedule('RecordingJob', ['x'])

    assert.deepEqual(RecordingJob.scheduled, [{ reportId: 8 }, {}, {}, {}, {}, {}, {}])
  })

  test('schedules a known job and swallows lookup and execution failures', async ({ assert }) => {
    const logs = captureLogger()
    try {
      const scheduler = await bindScheduler()
      await scheduler.schedule('RecordingJob', { reportId: 4 })
      await scheduler.schedule('MissingJob', {})
      await scheduler.schedule('ExplodingJob', { reportId: 9 })

      assert.deepEqual(RecordingJob.scheduled, [{ reportId: 4 }])
      assert.include(logs.texts('error'), '[Scheduler] Cannot find job MissingJob')
      assert.include(logs.texts('error'), '[Scheduler] Cannot schedule job ExplodingJob')
    } finally {
      logs.restore()
    }
  })

  test('clears the schedule cache and keeps the version', async ({ assert }) => {
    const scheduler = await bindScheduler()
    const cache = await getCache()
    await cache.set({ key: TEST_SCHEDULER_CONFIG.cacheKey, value: ['cached'] })
    await cache.set({ key: TEST_SCHEDULER_CONFIG.versionKey, value: '3.0.0' })

    await scheduler.clearCache()

    assert.isUndefined(await cache.get({ key: TEST_SCHEDULER_CONFIG.cacheKey }))
    assert.equal(await cache.get({ key: TEST_SCHEDULER_CONFIG.versionKey }), '3.0.0')
  })
})

async function withScheduler(
  configOrRun: Partial<SchedulerConfig> | ((scheduler: Scheduler, clock: Clock) => Promise<void>),
  run?: (scheduler: Scheduler, clock: Clock) => Promise<void>
) {
  const config = typeof configOrRun === 'function' ? {} : configOrRun
  const execute = typeof configOrRun === 'function' ? configOrRun : run
  if (!execute) {
    throw new Error('Missing scheduler test callback')
  }
  const scheduler = await bindScheduler({
    lockKey: `scheduler:lock:${++lockSequence}`,
    ...config,
  })
  try {
    await withClock(DUE_AT, async (clock) => {
      try {
        await execute(scheduler, clock)
      } finally {
        await scheduler.stop()
      }
    })
  } finally {
    await scheduler.stop()
  }
}

async function insert(
  overrides: Partial<{
    cronExpression: string
    tz: string
    jobName: string
    jobParams: object
    status: boolean
  }> = {}
) {
  return Schedule.create({
    cronExpression: '* * * * *',
    tz: 'UTC',
    jobName: 'RecordingJob',
    jobParams: { reportId: 1 },
    status: true,
    ...overrides,
  })
}

function read(scheduler: Scheduler) {
  return scheduler as unknown as {
    status: number
    scheduleTasks(): Promise<void>
  }
}

function readInternals(scheduler: Scheduler) {
  return scheduler as unknown as {
    lock: {
      extend: (this: { extend: () => Promise<void> }) => Promise<void>
      release: () => Promise<void>
    }
    stopLock: {
      runImmediately: (callback: () => Promise<unknown>) => Promise<unknown>
    }
    extendLock: () => Promise<void>
    releaseLock: () => Promise<void>
  }
}

async function waitUntil(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function payload(value: unknown) {
  if (typeof value === 'string') {
    return JSON.parse(value) as unknown
  }
  return value
}

async function cachedVersion() {
  const cache = await getCache()
  return cache.get({ key: TEST_SCHEDULER_CONFIG.versionKey })
}

function getVersionConfig(version: string) {
  getApp().config.set('version', { version })
}

function captureLogger() {
  const messages: { level: 'debug' | 'error' | 'trace'; args: unknown[] }[] = []
  const originalDebug = logger.debug
  const originalError = logger.error
  const originalTrace = logger.trace
  logger.debug = ((...args: unknown[]) => {
    messages.push({ level: 'debug', args })
  }) as typeof logger.debug
  logger.error = ((...args: unknown[]) => {
    messages.push({ level: 'error', args })
  }) as typeof logger.error
  logger.trace = ((...args: unknown[]) => {
    messages.push({ level: 'trace', args })
  }) as typeof logger.trace

  return {
    texts(level: 'debug' | 'error' | 'trace') {
      return messages
        .filter((message) => message.level === level)
        .map((message) => message.args.map(String).join(' '))
    },
    restore() {
      logger.debug = originalDebug
      logger.error = originalError
      logger.trace = originalTrace
    },
  }
}
