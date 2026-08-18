import { defineConfig, devices } from '@playwright/test';

// 에이전트가 동시에 돌려도 서로의 서버를 재사용하지 않도록 포트를 분리한다.
// E2E_PORT를 지정하지 않으면 기존 기본값 4788을 그대로 쓴다.
const E2E_PORT = Number(process.env.E2E_PORT || 4788);

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `PORT=${E2E_PORT} node static-server.js`,
    cwd: __dirname,
    port: E2E_PORT,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
