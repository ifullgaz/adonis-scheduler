import vine, { VineString } from '@vinejs/vine'
import { type FieldContext } from '@vinejs/vine/types'
import { CronExpressionParser } from 'cron-parser'
import { DateTime } from 'luxon'
import '@ifullgaz/adonis-jobs/validators'

declare module '@vinejs/vine' {
  interface VineString {
    cronExpression(): this
    timezone(): this
  }
}

VineString.macro('cronExpression', function (this: VineString) {
  return (this as any).use(cronExpressionRule())
})

const cronExpression = (value: unknown, _options: any, field: FieldContext) => {
  if (typeof value !== 'string') {
    return
  }
  // cron-parser treats "H" as a fresh random value on every parse.
  if (/H/.test(value)) {
    field.report('The value of {{ field }} is not a valid cron expression', 'cronExpression', field)
    return
  }
  try {
    CronExpressionParser.parse(value)
  } catch {
    field.report('The value of {{ field }} is not a valid cron expression', 'cronExpression', field)
  }
}

const cronExpressionRule = vine.createRule(cronExpression)

VineString.macro('timezone', function (this: VineString) {
  return (this as any).use(timezoneRule())
})

const timezone = (value: unknown, _options: any, field: FieldContext) => {
  if (typeof value !== 'string') {
    return
  }
  if (!DateTime.now().setZone(value).isValid) {
    field.report('The value of {{ field }} is not a valid timezone', 'timezone', field)
  }
}

const timezoneRule = vine.createRule(timezone)

export const createScheduleValidator = vine.create(
  vine.object({
    cronExpression: vine.string().trim().minLength(1).maxLength(128).cronExpression(),
    tz: vine.string().trim().maxLength(255).timezone(),
    jobName: vine.string().trim().maxLength(128).jobName(),
    jobParams: vine.object({}).allowUnknownProperties(),
    status: vine.boolean().optional(),
  })
)

export const updateScheduleValidator = vine.create(
  vine.object({
    cronExpression: vine.string().trim().minLength(1).maxLength(128).cronExpression().optional(),
    tz: vine.string().trim().maxLength(255).timezone().optional(),
    jobName: vine.string().trim().maxLength(128).jobName().optional(),
    jobParams: vine.object({}).allowUnknownProperties().optional(),
    status: vine.boolean().optional(),
  })
)
