#!/usr/bin/env node
// Runs tests.html in headless Chromium via Puppeteer.
// Exits 0 if all tests pass, 1 if any test fails.

import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsPath = resolve(__dirname, 'tests.html');

// Find a working Chrome binary. On CI (Linux, matching arch), Puppeteer's bundled
// Chrome works out of the box — return null to let Puppeteer auto-detect.
// Locally (e.g. x64 Node on arm64 Mac), the bundled download may fail — search
// the Puppeteer cache for any available chrome-headless-shell binary.
// Override with PUPPETEER_EXECUTABLE_PATH env var if needed.
function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const cacheDir = join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  if (!existsSync(cacheDir)) return null;
  try {
    const versions = readdirSync(cacheDir).filter(d => d.startsWith('mac-') || d.startsWith('linux-')).sort().reverse();
    for (const ver of versions) {
      const verDir = join(cacheDir, ver);
      const subdirs = readdirSync(verDir);
      for (const sub of subdirs) {
        const bin = join(verDir, sub, 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  } catch {}
  return null;
}

async function run() {
  const launchOptions = {
    headless: true,
    args: process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox'] : []
  };
  const chrome = findChrome();
  if (chrome) launchOptions.executablePath = chrome;
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') console.error('[browser]', msg.text());
  });

  await page.goto(`file://${testsPath}`, { waitUntil: 'load' });
  await page.waitForSelector('.summary', { timeout: 10000 });

  const result = await page.evaluate(() => {
    const summary = document.querySelector('.summary');
    const failures = [...document.querySelectorAll('.fail')].map(el => el.textContent);
    return {
      text: summary.textContent,
      allPass: summary.classList.contains('all-pass'),
      failures
    };
  });

  await browser.close();

  console.log(result.text);

  if (!result.allPass) {
    for (const f of result.failures) console.error(f);
    process.exit(1);
  }

  process.exit(0);
}

run().catch(err => {
  console.error('Headless test runner failed:', err.message);
  process.exit(2);
});
