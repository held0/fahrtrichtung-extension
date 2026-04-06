#!/usr/bin/env node
// Runs tests.html in headless Chromium via Puppeteer.
// Exits 0 if all tests pass, 1 if any test fails.

import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsPath = resolve(__dirname, 'tests.html');

// Resolve the best available Chrome/Chromium executable.
// Priority: puppeteer's own cache -> system Chrome (macOS)
function findChrome() {
  const puppeteerCache = '/Users/resistance/.cache/puppeteer';
  const candidates = [
    // chrome-headless-shell builds in the puppeteer cache (sorted newest-first at runtime)
    ...['chrome-headless-shell', 'chrome'].flatMap(kind => {
      const base = `${puppeteerCache}/${kind}`;
      if (!existsSync(base)) return [];
      try {
        return execSync(`ls "${base}"`, { encoding: 'utf8' })
          .trim().split('\n')
          .sort().reverse()
          .flatMap(ver => {
            const sub = `${base}/${ver}`;
            try {
              return execSync(`ls "${sub}"`, { encoding: 'utf8' })
                .trim().split('\n')
                .map(dir => {
                  const bin = kind === 'chrome-headless-shell'
                    ? `${sub}/${dir}/chrome-headless-shell`
                    : `${sub}/${dir}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
                  return bin;
                })
                .filter(p => existsSync(p));
            } catch { return []; }
          });
      } catch { return []; }
    }),
    // System Chrome as last resort
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find(p => existsSync(p)) || null;
}

async function run() {
  const executablePath = findChrome();
  const launchOptions = { headless: true };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

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
