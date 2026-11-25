import { type DateTime } from 'luxon'
import app from '@adonisjs/core/services/app'
import { compose } from '@adonisjs/core/helpers'
import { afterDelete, afterSave, BaseModel, column } from '@adonisjs/lucid/orm'
import { json, dateTime, boolean } from '@ifullgaz/adonis-lucid/columns'
import { withScopedModel } from '@ifullgaz/adonis-lucid/traits'
import type Scheduler from '../core/scheduler.js'

export default class Schedule extends compose(BaseModel, withScopedModel()) {
  @afterSave()
  static async afterSave() {
    await this.clearSchedulerCache()
  }

  @afterDelete()
  static async afterDelete() {
    await this.clearSchedulerCache()
  }

  /**
   * Drop the cached schedule list through the scheduler singleton.
   * The row is already committed when these hooks run.
   */
  private static async clearSchedulerCache() {
    const scheduler = (await app.container.make('scheduler')) as Scheduler
    await scheduler.clearCache()
  }

  @column({ isPrimary: true })
  declare id: number
  @column()
  declare cronExpression: string
  @column()
  declare tz: string
  @column()
  declare jobName: string
  @json()
  declare jobParams: object
  @boolean()
  declare status: boolean

  @dateTime({ autoCreate: true })
  declare createdAt: DateTime
  @dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  public async run(payload: object = {}) {
    const jobParams = {
      ...this.jobParams,
      ...payload,
    }
    const scheduler = (await app.container.make('scheduler')) as Scheduler
    await scheduler.schedule(this.jobName, jobParams)
  }
}
