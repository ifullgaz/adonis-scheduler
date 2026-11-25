import { test } from '@japa/runner'
import { type Assert } from '@japa/assert'
import vine, { ValidationError } from '@vinejs/vine'
import { createScheduleValidator, updateScheduleValidator } from '../src/validators/schedule.js'

type FieldError = { field: string; rule: string }

const validCreate = {
  cronExpression: '  * * * * *  ',
  tz: ' UTC ',
  jobName: '  RecordingJob  ',
  jobParams: { reportId: 1, nested: { ok: true } },
  status: true,
}

test.group('Schedule validators', () => {
  test('accepts a trimmed create payload and an optional status', async ({ assert }) => {
    assert.deepEqual(await createScheduleValidator.validate(validCreate), {
      cronExpression: '* * * * *',
      tz: 'UTC',
      jobName: 'RecordingJob',
      jobParams: { reportId: 1, nested: { ok: true } },
      status: true,
    })

    const withoutStatus = await createScheduleValidator.validate({
      cronExpression: '@hourly',
      tz: 'America/New_York',
      jobName: 'RecordingJob',
      jobParams: {},
    })
    assert.deepEqual(withoutStatus, {
      cronExpression: '@hourly',
      tz: 'America/New_York',
      jobName: 'RecordingJob',
      jobParams: {},
    })
    assert.isUndefined(withoutStatus.status)

    const atLimit = await createScheduleValidator.validate({
      cronExpression: '* * * * *',
      tz: 'Europe/Paris',
      jobName: 'RecordingJob',
      jobParams: { extra: true },
      status: false,
    })
    assert.equal(atLimit.tz, 'Europe/Paris')
    assert.deepEqual(atLimit.jobParams, { extra: true })
    assert.isFalse(atLimit.status)
  })

  test('rejects an invalid create payload', async ({ assert }) => {
    await assertField(
      assert,
      () => createScheduleValidator.validate({}),
      'cronExpression',
      'required'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          cronExpression: 'not a cron',
        }),
      'cronExpression',
      'cronExpression'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          cronExpression: 'a'.repeat(129),
        }),
      'cronExpression',
      'maxLength'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          cronExpression: '   ',
        }),
      'cronExpression',
      'minLength'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          cronExpression: '0 H * * *',
        }),
      'cronExpression',
      'cronExpression'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          tz: undefined,
        }),
      'tz',
      'required'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          tz: 't'.repeat(256),
        }),
      'tz',
      'maxLength'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          tz: 'Not/AZone',
        }),
      'tz',
      'timezone'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          jobName: 'MissingJob',
        }),
      'jobName',
      'jobName'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          jobName: 'j'.repeat(129),
        }),
      'jobName',
      'maxLength'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          jobParams: undefined,
        }),
      'jobParams',
      'required'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          jobParams: [],
        }),
      'jobParams',
      'object'
    )
    await assertField(
      assert,
      () =>
        createScheduleValidator.validate({
          ...validCreate,
          status: 'yes',
        }),
      'status',
      'boolean'
    )
  })

  test('accepts a partial update', async ({ assert }) => {
    assert.deepEqual(await updateScheduleValidator.validate({}), {})
    assert.deepEqual(
      await updateScheduleValidator.validate({
        cronExpression: ' 0 * * * * ',
        tz: ' UTC ',
        jobName: ' RecordingJob ',
        jobParams: { reportId: 2 },
        status: false,
        extra: true,
      }),
      {
        cronExpression: '0 * * * *',
        tz: 'UTC',
        jobName: 'RecordingJob',
        jobParams: { reportId: 2 },
        status: false,
      }
    )
  })

  test('ignores non-string values inside the cron and timezone rules', ({ assert }) => {
    const cron = ruleValidator(vine.string().cronExpression())
    const timezone = ruleValidator(vine.string().timezone())
    let reported = false
    const field = {
      report() {
        reported = true
      },
    }

    cron(1, undefined, field)
    timezone({ zone: 'UTC' }, undefined, field)

    assert.isFalse(reported)
  })

  test('rejects an invalid update payload', async ({ assert }) => {
    await assertField(
      assert,
      () => updateScheduleValidator.validate({ cronExpression: 'not a cron' }),
      'cronExpression',
      'cronExpression'
    )
    await assertField(
      assert,
      () => updateScheduleValidator.validate({ tz: 't'.repeat(256) }),
      'tz',
      'maxLength'
    )
    await assertField(
      assert,
      () => updateScheduleValidator.validate({ tz: 'Not/AZone' }),
      'tz',
      'timezone'
    )
    await assertField(
      assert,
      () => updateScheduleValidator.validate({ jobName: 'MissingJob' }),
      'jobName',
      'jobName'
    )
    assert.deepEqual(await updateScheduleValidator.validate({ jobParams: null }), {})
    assert.deepEqual(await updateScheduleValidator.validate({ status: 1 }), { status: true })
    await assertField(
      assert,
      () => updateScheduleValidator.validate({ status: 'yes' }),
      'status',
      'boolean'
    )
  })
})

function ruleValidator(schema: object) {
  const validations = (
    schema as {
      validations: Array<{
        rule: {
          validator: (value: unknown, options: undefined, field: { report: () => void }) => void
        }
      }>
    }
  ).validations
  return validations[0].rule.validator
}

async function assertField(
  assert: Assert,
  run: () => Promise<unknown>,
  field: string,
  rule: string
) {
  const errors = await validationErrors(run)
  assert.include(
    errors.map((error) => `${error.field}:${error.rule}`),
    `${field}:${rule}`
  )
}

async function validationErrors(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    if (error instanceof ValidationError) {
      return error.messages as FieldError[]
    }
    throw error
  }
  throw new Error('Expected validation to fail')
}
