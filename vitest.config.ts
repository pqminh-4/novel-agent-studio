import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('packages/core/src'),
      '@infra': resolve('packages/infrastructure/src')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/{core,infrastructure}/src/**/*.ts'],
      exclude: ['packages/{core,infrastructure}/src/index.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 70,
        functions: 65,
        branches: 60,
        statements: 70
      }
    }
  }
})
