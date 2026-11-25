import { type ApplicationService } from '@adonisjs/core/types'
import logger from '@adonisjs/core/services/logger'
import cache from '@adonisjs/cache/services/main'
import locks from '@adonisjs/lock/services/main'
import db from '@adonisjs/lucid/services/db'
import { modelFields } from '@ifullgaz/adonis-lucid/utils'
import { getCurrentVersion } from '@ifullgaz/adonis-lucid/utils'
import { type JobsRegistryContract } from '@ifullgaz/adonis-jobs/contracts'
import string from '@poppinss/utils/string'
import { CronExpressionParser } from 'cron-parser'
import lt from 'semver/functions/lt.js'
import gt from 'semver/functions/gt.js'
import Schedule from '../model/schedule.js'
import { type SchedulerContract } from './contracts/scheduler_contract.js'
import { type SchedulerConfig } from '../types/types.js'

const VERSION_TTL = null

enum ScheduleStatus {
  STOPPED = 0,
  STARTING = 1,
  RUNNING = 2,
  STOPPING = 3,
  TERMINATED = 4,
}

type ScheduleRow = {
  id: number | string
  cron_expression: string
  tz: string
  job_name: string
  job_params: unknown
}

class Scheduler implements SchedulerContract {
  private status: ScheduleStatus = ScheduleStatus.STOPPED

  private lock: any

  private stopLock: any

  private acquired: boolean = false

  private lockExtendInterval: NodeJS.Timeout | undefined = undefined

  private schedulerTimeout: NodeJS.Timeout | undefined = undefined

  private jobsRegistry: JobsRegistryContract | undefined = undefined

  constructor(
    private readonly app: ApplicationService,
    private readonly config: SchedulerConfig
  ) {}

  private createStopLock() {
    this.stopLock = locks.use('memory').createLock('scheduler:stop')
  }

  private lockTiming() {
    const seconds = string.seconds.parse(this.config.lockTtl)
    return {
      ttlMs: seconds * 1000,
      extendEveryMs: seconds * 500,
    }
  }

  private startLockExtendInterval() {
    const timing = this.lockTiming()
    this.lock = locks.createLock(this.config.lockKey, timing.ttlMs)
    this.lockExtendInterval = setInterval(() => {
      void this.extendLock()
    }, timing.extendEveryMs)
  }

  private async extendLock() {
    if (!this.acquired) {
      return
    }
    try {
      await this.lock.extend()
    } catch (error) {
      this.acquired = false
      logger.error(
        `[Scheduler] Cannot extend lock ${this.config.lockKey}: ${(error as Error).message}`
      )
      try {
        await this.lock.release()
      } catch (releaseError) {
        logger.trace(
          `[Scheduler] Lock ${this.config.lockKey} was already released: ${(releaseError as Error).message}`
        )
      }
    }
  }

  private async releaseLock() {
    if (!this.acquired) {
      return
    }
    this.acquired = false
    try {
      await this.lock.release()
    } catch (error) {
      logger.error(
        `[Scheduler] Cannot release lock ${this.config.lockKey}: ${(error as Error).message}`
      )
    }
  }

  private async stopLockExtendInterval() {
    clearInterval(this.lockExtendInterval)
    await this.releaseLock()
  }

  private startSchedulerTimeout(afterWake: boolean) {
    this.stopSchedulerTimeout()
    if (afterWake && this.status !== ScheduleStatus.RUNNING) {
      return
    }
    const delay = this.calculateDelay(afterWake)
    this.schedulerTimeout = setTimeout(async () => {
      await this.scheduleTasks()
    }, delay)
    logger.trace(`[Scheduler] Scheduler timeout set for ${delay}ms`)
  }

  private stopSchedulerTimeout() {
    clearTimeout(this.schedulerTimeout)
  }

  private async asyncCloseDatabaseConnections() {
    try {
      await db.manager.closeAll()
    } catch (error) {
      logger.error(`[Scheduler] Cannot close database connections: ${(error as Error).message}`)
    }
  }

  private async scheduleTasks() {
    try {
      await this.stopLock.runImmediately(async () => {
        await this.runScheduleTasks()
      })
    } catch (error) {
      logger.error(`[Scheduler] Scheduler tasks failed: ${(error as Error).message}`)
      this.startSchedulerTimeout(true)
    }
  }

  private async runScheduleTasks() {
    try {
      const eligible = await this.checkEligibility()
      if (!eligible) {
        await this.releaseLock()
        return
      }
      const schedules = await this.getSchedules()
      const now = new Date()
      now.setUTCSeconds(0, 0)
      for (const schedule of schedules) {
        await this.dispatchSchedule(schedule, now)
      }
    } catch (error) {
      logger.error(`[Scheduler] Scheduler wake failed: ${(error as Error).message}`)
    } finally {
      this.startSchedulerTimeout(true)
    }
  }

  private async checkEligibility(): Promise<boolean> {
    const version = await getCurrentVersion()
    const schedulerVersion = await cache.getOrSet({
      key: this.config.versionKey,
      factory: async () => {
        return version
      },
      ttl: VERSION_TTL,
    })
    if (lt(version, schedulerVersion)) {
      logger.trace(`[Scheduler] Scheduler version ${version} is older than ${schedulerVersion}`)
      return false
    } else if (gt(version, schedulerVersion)) {
      await cache.set({
        key: this.config.versionKey,
        value: version,
        ttl: VERSION_TTL,
      })
    }
    if (!this.acquired) {
      this.acquired = await this.lock.acquireImmediately()
      logger.trace(
        `[Scheduler] Scheduler has ${this.acquired ? 'acquired' : 'not acquired'} the lock`
      )
    }
    return this.acquired
  }

  private async getSchedules(): Promise<ScheduleRow[]> {
    return await cache.getOrSet({
      key: this.config.cacheKey,
      factory: async () => {
        const schedules = await Schedule.query()
          .select(modelFields(Schedule))
          .where('status', 1)
          .pojo()
        return schedules as ScheduleRow[]
      },
      ttl: 3600 * 24 * 1000, // 24 hours
    })
  }

  private async dispatchSchedule(schedule: ScheduleRow, minuteStart: Date) {
    try {
      if (!this.cronMatchesMinute(schedule.cron_expression, schedule.tz, minuteStart)) {
        return
      }
      await this.schedule(schedule.job_name, schedule.job_params)
    } catch (error) {
      logger.error(
        `[Scheduler] Cannot evaluate schedule ${schedule.id}: ${(error as Error).message}`
      )
    }
  }

  /**
   * prev() skips an instant that is exactly the occurrence. Probe 1ms later
   * so a wake on the minute includes that minute.
   */
  private cronMatchesMinute(expression: string, tz: string, minuteStart: Date) {
    const probe = new Date(minuteStart.getTime() + 1)
    const cronExpression = CronExpressionParser.parse(expression, {
      tz,
      currentDate: probe,
    })
    return cronExpression.prev().getTime() === minuteStart.getTime()
  }

  private calculateDelay(afterWake: boolean) {
    const now = new Date()
    const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds()
    if (delay === 60_000) {
      return afterWake ? 60_000 : 0
    }
    return delay
  }

  private jobPayload(value: unknown) {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown
        if (this.isPayload(parsed)) {
          return parsed
        }
      } catch {
        return {}
      }
      return {}
    }
    if (this.isPayload(value)) {
      return value
    }
    return {}
  }

  private isPayload(value: unknown): value is object {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  public async schedule(job_name: string, job_params: unknown) {
    try {
      if (!this.jobsRegistry) {
        this.jobsRegistry = (await this.app.container.make('jobsRegistry')) as JobsRegistryContract
      }
      const jobClass = await this.jobsRegistry.getJob(job_name)
      if (!jobClass) {
        logger.error(`[Scheduler] Cannot find job ${job_name}`)
        return
      }
      await jobClass.schedule(this.jobPayload(job_params))
    } catch {
      logger.error(`[Scheduler] Cannot schedule job ${job_name}`)
    }
  }

  public async clearCache() {
    await cache.delete({
      key: this.config.cacheKey,
    })
  }

  public async stop() {
    if (this.app.getEnvironment() !== 'console') {
      logger.debug('[Scheduler] Scheduler can only be stopped in console environment')
      return
    }
    if (this.status !== ScheduleStatus.RUNNING) {
      logger.debug('[Scheduler] Scheduler already stopped')
      return
    }
    this.status = ScheduleStatus.STOPPING
    await this.stopLock.run(async () => {
      logger.debug('[Scheduler] Stopping scheduler')
      this.stopSchedulerTimeout()
      await this.stopLockExtendInterval()
      await this.asyncCloseDatabaseConnections()
      logger.debug('[Scheduler] Scheduler stopped')
    })
    this.status = ScheduleStatus.TERMINATED
  }

  public async start() {
    if (this.app.getEnvironment() !== 'console') {
      logger.debug('[Scheduler] Scheduler can only be started in console environment')
      return
    }
    if (this.status !== ScheduleStatus.STOPPED) {
      logger.debug('[Scheduler] Scheduler already started')
      return
    }
    this.status = ScheduleStatus.STARTING
    logger.debug('[Scheduler] Starting scheduler')
    this.createStopLock()
    this.startLockExtendInterval()
    this.startSchedulerTimeout(false)
    this.status = ScheduleStatus.RUNNING
    logger.debug('[Scheduler] Scheduler started')
  }
}

export default Scheduler
