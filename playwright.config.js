import { defineConfig } from '@playwright/test';
import { testConfig } from './tests/database.js';

testConfig();
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  // Auth cookies and invitation links are sensitive; do not record traces/videos.
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      APP_ORIGIN: 'http://localhost:5173',
      NODE_ENV: 'test',
      MAIL_TRANSPORT: 'file',
      MAIL_DIRECTORY: '.local/e2e-mail',
      PORT: '3001',
    },
  },
});
