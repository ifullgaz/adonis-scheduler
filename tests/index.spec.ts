import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { defineConfig } from '../src/define_config.js'

test.group('package entry', () => {
  test('exports the runtime api and the config stub', async ({ assert }) => {
    const entry = await import('../index.js')
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { exports: Record<string, string> }
    const stub = await readFile(join(entry.stubsRoot, 'config.stub'), 'utf8')

    assert.deepEqual(Object.keys(entry).sort(), ['configure', 'defineConfig', 'stubsRoot'])
    assert.isFunction(entry.configure)
    assert.strictEqual(entry.defineConfig, defineConfig)
    assert.isTrue(entry.stubsRoot.endsWith('stubs'))
    assert.deepEqual(manifest.exports, {
      '.': './build/index.js',
      './commands': './build/src/commands/main.js',
      './contracts': './build/src/core/contracts/main.js',
      './model': './build/src/model/schedule.js',
      './provider': './build/providers/provider.js',
      './types': './build/src/types/types.js',
      './validators': './build/src/validators/schedule.js',
    })
    assert.include(stub, "app.configPath('scheduler.ts')")
    assert.include(stub, "import { defineConfig } from '@ifullgaz/adonis-scheduler'")
    assert.include(stub, "cacheKey: 'scheduler:cache'")
    assert.include(stub, "lockKey: 'scheduler:lock'")
    assert.include(stub, 'lockTtl: 10')
    assert.include(stub, "versionKey: 'scheduler:version'")
  })
})
