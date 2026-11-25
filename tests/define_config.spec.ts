import { test } from '@japa/runner'
import { defineConfig } from '../src/define_config.js'

test.group('defineConfig', () => {
  test('returns the same config reference', ({ assert }) => {
    const config = {
      cacheKey: 'scheduler:cache',
      lockKey: 'scheduler:lock',
      lockTtl: '10s' as const,
      versionKey: 'scheduler:version',
    }

    const defined = defineConfig(config)

    assert.strictEqual(defined, config)
    assert.equal(defined.cacheKey, 'scheduler:cache')
    assert.equal(defined.lockKey, 'scheduler:lock')
    assert.equal(defined.lockTtl, '10s')
    assert.equal(defined.versionKey, 'scheduler:version')
  })

  test('keeps a numeric lock ttl', ({ assert }) => {
    const config = defineConfig({
      cacheKey: 'scheduler:cache',
      lockKey: 'scheduler:lock',
      lockTtl: 10,
      versionKey: 'scheduler:version',
    })

    assert.equal(config.lockTtl, 10)
  })
})
