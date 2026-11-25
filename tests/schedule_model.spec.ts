import { test } from '@japa/runner'
import Schedule from '../src/model/schedule.js'
import { RecordingJob } from './helpers/recording_job.js'
import {
  TEST_SCHEDULER_CONFIG,
  bindScheduler,
  getApp,
  getCache,
  resetStorage,
} from './helpers/app.js'

test.group('Schedule model', (group) => {
  group.each.setup(async () => {
    await resetStorage()
    await bindScheduler()
  })

  test('stores cron, timezone, job, params, and status', async ({ assert }) => {
    assert.equal(Schedule.table, 'schedules')

    const disabled = await Schedule.create({
      cronExpression: '0 * * * *',
      tz: 'UTC',
      jobName: 'RecordingJob',
      jobParams: { nested: { ok: true } },
      status: false,
    })
    const enabled = await Schedule.create({
      cronExpression: '* * * * *',
      tz: 'America/New_York',
      jobName: 'RecordingJob',
      jobParams: { reportId: 1 },
      status: true,
    })

    const freshDisabled = await Schedule.findOrFail(disabled.id)
    const freshEnabled = await Schedule.findOrFail(enabled.id)

    assert.equal(freshDisabled.cronExpression, '0 * * * *')
    assert.equal(freshDisabled.tz, 'UTC')
    assert.equal(freshDisabled.jobName, 'RecordingJob')
    assert.deepEqual(freshDisabled.jobParams, { nested: { ok: true } })
    assert.isFalse(freshDisabled.status)
    assert.isTrue(freshDisabled.createdAt.isValid)
    assert.isTrue(freshDisabled.updatedAt.isValid)

    assert.equal(freshEnabled.tz, 'America/New_York')
    assert.deepEqual(freshEnabled.jobParams, { reportId: 1 })
    assert.isTrue(freshEnabled.status)
  })

  test('clears the scheduler cache after a save and a delete', async ({ assert }) => {
    const cache = await getCache()
    await cache.set({ key: TEST_SCHEDULER_CONFIG.cacheKey, value: ['stale-create'] })

    const schedule = await Schedule.create(scheduleRow())
    assert.isUndefined(await cache.get({ key: TEST_SCHEDULER_CONFIG.cacheKey }))

    await cache.set({ key: TEST_SCHEDULER_CONFIG.cacheKey, value: ['stale-update'] })
    schedule.tz = 'Europe/Paris'
    await schedule.save()
    assert.isUndefined(await cache.get({ key: TEST_SCHEDULER_CONFIG.cacheKey }))
    const saved = await Schedule.findOrFail(schedule.id)
    assert.equal(saved.tz, 'Europe/Paris')

    await cache.set({ key: TEST_SCHEDULER_CONFIG.cacheKey, value: ['stale-delete'] })
    await cache.set({ key: TEST_SCHEDULER_CONFIG.versionKey, value: '9.9.9' })
    await schedule.delete()
    assert.isUndefined(await cache.get({ key: TEST_SCHEDULER_CONFIG.cacheKey }))
    assert.equal(await cache.get({ key: TEST_SCHEDULER_CONFIG.versionKey }), '9.9.9')
    assert.isNull(await Schedule.find(schedule.id))
  })

  test('clears the cache through the bound scheduler after save', async ({ assert }) => {
    const cache = await getCache()
    await cache.set({ key: TEST_SCHEDULER_CONFIG.cacheKey, value: ['stale'] })
    await cache.set({ key: 'other:key', value: ['kept'] })

    await Schedule.create(scheduleRow())

    assert.isUndefined(await cache.get({ key: TEST_SCHEDULER_CONFIG.cacheKey }))
    assert.deepEqual(await cache.get({ key: 'other:key' }), ['kept'])
    assert.equal(getApp().container.hasBinding('scheduler'), true)
  })

  test('runs the job with stored params overridden by the payload', async ({ assert }) => {
    const schedule = await Schedule.create({
      ...scheduleRow(),
      jobParams: { reportId: 1, keep: true },
    })

    await schedule.run()
    await schedule.run({ reportId: 2, extra: 'x' })

    assert.deepEqual(RecordingJob.scheduled, [
      { reportId: 1, keep: true },
      { reportId: 2, keep: true, extra: 'x' },
    ])
  })
})

function scheduleRow() {
  return {
    cronExpression: '* * * * *',
    tz: 'UTC',
    jobName: 'RecordingJob',
    jobParams: { reportId: 1 },
    status: true,
  }
}
