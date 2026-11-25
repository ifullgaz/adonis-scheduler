import { test } from '@japa/runner'
import { IgnitorFactory } from '@adonisjs/core/factories'
import SchedulerProvider from '../providers/provider.js'
import Scheduler from '../src/core/scheduler.js'
import { restoreTestApp } from './helpers/app.js'

const schedulerConfig = {
  cacheKey: 'from-console',
  lockKey: 'from-console-lock',
  lockTtl: 60_000,
  versionKey: 'from-console-version',
}

const STATUS_STOPPED = 0

test.group('SchedulerProvider', () => {
  test('registers one scheduler from the scheduler config in a console app', async ({ assert }) => {
    const app = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          providers: [() => import('../providers/provider.js')],
        },
      })
      .create(new URL('../', import.meta.url), {
        importer: (filePath) => import(filePath),
      })
      .createApp('console')

    try {
      await app.init()
      await app.boot()
      app.config.set('scheduler', schedulerConfig)

      const first = await app.container.make('scheduler')
      const second = await app.container.make('scheduler')

      assert.instanceOf(first, Scheduler)
      assert.strictEqual(first, second)
      assert.deepEqual(readConfig(first as Scheduler), schedulerConfig)
    } finally {
      await app.terminate()
      restoreTestApp()
    }
  })

  test('registers the scheduler in a web app but start and stop are no-ops', async ({ assert }) => {
    const app = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          providers: [() => import('../providers/provider.js')],
        },
      })
      .create(new URL('../', import.meta.url), {
        importer: (filePath) => import(filePath),
      })
      .createApp('web')

    try {
      await app.init()
      await app.boot()
      app.config.set('scheduler', schedulerConfig)
      new SchedulerProvider(app).register()

      assert.equal(app.getEnvironment(), 'web')
      assert.isTrue(app.container.hasBinding('scheduler'))

      const scheduler = (await app.container.make('scheduler')) as Scheduler
      await scheduler.start()
      await scheduler.stop()
      assert.equal(readStatus(scheduler), STATUS_STOPPED)
    } finally {
      await app.terminate()
      restoreTestApp()
    }
  })
})

function readConfig(scheduler: Scheduler) {
  return (scheduler as unknown as { config: typeof schedulerConfig }).config
}

function readStatus(scheduler: Scheduler) {
  return (scheduler as unknown as { status: number }).status
}
