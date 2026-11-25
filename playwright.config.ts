import { defineConfig } from '@playwright/test';

const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  use: { baseURL: external ?? 'http://localhost:3000' },
  webServer: external
    ? undefined
    : {
        command: 'npm run build && npm run start',
        url: 'http://localhost:3000/signin',
        reuseExistingServer: true,
        timeout: 240000,
      },
});
