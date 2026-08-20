import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@core': resolve('packages/core/src'),
        '@infra': resolve('packages/infrastructure/src')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('apps/desktop/src/main/index.ts'),
          runtime: resolve('apps/desktop/src/main/runtime.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('apps/desktop/src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    root: resolve('apps/desktop/src/renderer'),
    resolve: {
      alias: {
        '@core': resolve('packages/core/src'),
        '@renderer': resolve('apps/desktop/src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('apps/desktop/src/renderer/index.html')
      }
    }
  }
})
