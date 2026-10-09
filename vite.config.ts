import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022' },
  // Select DOM-free conditional exports (notably remark's entity decoder).
  resolve: { conditions: ['worker', 'module', 'browser', 'development|production'] },
  test: { include: ['src/**/*.test.ts'] },
})
