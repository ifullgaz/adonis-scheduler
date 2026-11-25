import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setApp } from '@adonisjs/core/services/app'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { defineConfig as defineCacheConfig, drivers, store } from '@adonisjs/cache'
import { defineConfig as defineLockConfig, stores } from '@adonisjs/lock'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import type { ApplicationService } from '@adonisjs/core/types'
import type { JobType } from '@ifullgaz/adonis-jobs/types'
import '@ifullgaz/adonis-jobs/provider'
import '../../providers/provider.js'
import type { SchedulerConfig } from '../../src/types/types.js'
import { ExplodingJob, RecordingJob } from './recording_job.js'

export const TEST_SCHEDULER_CONFIG: SchedulerConfig = {
  cacheKey: 'scheduler:cache',
  lockKey: 'scheduler:lock',
  lockTtl: 60_000,
  versionKey: 'scheduler:version',
}

let application: ApplicationService | undefined

export function getApp() {
  if (!application) {
    throw new Error('Test application is not booted')
  }
  return application
}

/**
 * Point the global app service back at the shared test app. Specs that boot a
 * short-lived host replace the global reference.
 */
export function restoreTestApp() {
  setApp(getApp())
}

export async function bootTestApp() {
  if (application) {
    return application
  }

  const filename = join(mkdtempSync(join(tmpdir(), 'adonis-scheduler-')), 'db.sqlite')
  application = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          () => import('@adonisjs/lucid/database_provider'),
          () => import('@adonisjs/cache/cache_provider'),
          () => import('@adonisjs/lock/lock_provider'),
          () => import('@ifullgaz/adonis-jobs/provider'),
          () => import('../../providers/provider.js'),
        ],
      },
      config: {
        database: defineDatabaseConfig({
          connection: 'sqlite',
          connections: {
            sqlite: {
              client: 'better-sqlite3',
              connection: { filename },
              useNullAsDefault: true,
              pool: { min: 1, max: 1 },
            },
          },
        }),
        cache: defineCacheConfig({
          default: 'memory',
          stores: {
            memory: store().useL1Layer(drivers.memory()),
          },
        }),
        lock: defineLockConfig({
          default: 'memory',
          stores: {
            memory: stores.memory(),
          },
        }),
      },
    })
    .create(new URL('../../', import.meta.url), {
      importer: (filePath) => import(filePath),
    })
    .createApp('console')

  await application.init()
  await application.boot()
  application.config.set('scheduler', TEST_SCHEDULER_CONFIG)
  application.config.set('version', { version: '1.0.0' })

  await import('@adonisjs/lucid/services/db')
  await import('@adonisjs/cache/services/main')
  await import('@adonisjs/lock/services/main')
  const logger = await import('@adonisjs/core/services/logger')
  logger.default.level = 'silent'

  await createSchema()
  const registry = await application.container.make('jobsRegistry')
  await registry.registerJob(RecordingJob as unknown as JobType)
  await registry.registerJob(ExplodingJob as unknown as JobType)
  return application
}

async function createSchema() {
  const database = await getDatabase()
  await database.connection().schema.createTable('schedules', (table) => {
    table.increments('id').notNullable()
    table.string('cron_expression', 128).notNullable()
    table.string('tz', 255).notNullable()
    table.string('job_name', 128).notNullable()
    table.json('job_params').notNullable()
    table.tinyint('status').notNullable().defaultTo(0)
    table.timestamp('created_at').nullable()
    table.timestamp('updated_at').nullable()
  })
}

export async function getDatabase() {
  const { default: db } = await import('@adonisjs/lucid/services/db')
  return db
}

export async function getCache() {
  const { default: cache } = await import('@adonisjs/cache/services/main')
  return cache
}

export async function getLocks() {
  const { default: locks } = await import('@adonisjs/lock/services/main')
  return locks
}

export async function bindScheduler(overrides: Partial<SchedulerConfig> = {}) {
  const { default: Scheduler } = await import('../../src/core/scheduler.js')
  const scheduler = new Scheduler(getApp(), { ...TEST_SCHEDULER_CONFIG, ...overrides })
  getApp().container.bindValue('scheduler', scheduler)
  return scheduler
}

export async function resetStorage() {
  RecordingJob.reset()
  const app = getApp()
  app.config.set('version', { version: '1.0.0' })
  const database = await getDatabase()
  await database.from('schedules').delete()
  const cache = await getCache()
  await cache.clear()
}

export async function shutdownTestApp() {
  if (!application) {
    return
  }
  await application.terminate()
  application = undefined
}
