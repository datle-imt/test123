/**
 * Customer Portal performance with optional native Windows passkey PIN automation.
 * Setup and usage: see README.md. PIN is loaded from local .env (never hardcoded).
 * --fresh-login: use a temporary browser context, not the saved portal session.
 * --manual-pin: automate the web buttons, but enter PIN and touch manually.
 * Login and native-dialog waiting are excluded from all three UI measurements.
 * Native PIN automation depends on Windows permissions/UIA accessibility.
 */

const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const LOGIN_URL = 'https://portal.yubico.com/login';
const SEARCH_EMAIL = 'dat.le_ext@yubico.com';
const WAIT_TIMEOUT_MS = 45_000;
const LOGIN_TIMEOUT_MS = 300_000;
const QUIET_MS = 200;

const PROFILE_DIR = path.join(__dirname, '.portal-playwright-profile');
const OUTPUT_CSV = path.join(__dirname, 'enrollment-performance-results.csv');
const DOTENV_PATH = path.join(__dirname, '.env');

const SELECTORS = {
  login: 'xpath=//a[text()="Login"]',
  passkey: 'xpath=//button[text()="Sign in with Passkey"]',
  enrollmentOpen: 'xpath=//span[text()="Enrollment"]/parent::div/button',
  nextPage: 'xpath=//button[@title="Go to next page"]',
  search: 'xpath=//input[@placeholder="Search"]',
};

// The helper runs concurrently: do not wait for a blocking native dialog before
// starting it. No PIN is placed on a command line or passed to the browser.
function startPinHelper(pin) {
  if (process.platform !== 'win32') {
    throw new Error('Automatic native PIN entry requires Windows. Use --manual-pin elsewhere.');
  }
  if (!pin) {
    throw new Error('Enter FIDO2_PIN in the local .env file, or use --manual-pin. Never hardcode the PIN.');
  }
  const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
  const python = process.env.PYTHON_EXE || (fs.existsSync(venvPython) ? venvPython : 'python');
  const helperPath = path.join(__dirname, 'windows-security-pin.py');
  const state = { finished: false, code: null, error: '', submissionAttempted: false };
  let resolveReady, rejectReady, resolveDone;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let isReady = false;
  const child = spawn(python, [
    '-u', helperPath, '--timeout', '90', '--rp', 'login.yubico.com',
    '--method', process.env.PIN_INPUT_METHOD || 'auto',
  ], {
    cwd: __dirname,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  const clean = (text) => String(text).split(pin).join('[REDACTED]');
  const startupTimer = setTimeout(() => {
    rejectReady(new Error('PIN helper did not initialize. Check PYTHON_EXE and requirements.txt.'));
    child.kill();
  }, 20_000);
  const watchdog = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS + 10_000);
  function finish(code, error = '') {
    if (state.finished) return;
    clearTimeout(startupTimer);
    clearTimeout(watchdog);
    state.finished = true;
    state.code = code;
    if (error) state.error = clean(error);
    if (!isReady) rejectReady(new Error(state.error || 'PIN helper exited before initialization.'));
    resolveDone(state);
  }
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (line === 'HELPER_READY') {
      isReady = true;
      clearTimeout(startupTimer);
      console.log('[LOGIN] Native PIN helper initialized; watching for Windows Security.');
      resolveReady();
    } else {
      if (line.includes('PIN submission attempted once')) state.submissionAttempted = true;
      console.log(clean(line));
    }
  });
  child.stderr.on('data', (data) => {
    const text = clean(data.toString('utf8')).trim();
    state.error = (state.error + '\n' + text).slice(-3000);
    console.error(text);
  });
  child.once('error', (error) => finish(1, `Cannot start Python (${error.code || 'spawn error'}). Check PYTHON_EXE.`));
  child.once('close', (code) => finish(code === null ? 1 : code));
  child.stdin.on('error', () => {}); // A failed helper can close its pipe early.
  child.stdin.end(JSON.stringify({ pin }), 'utf8');
  return {
    ready, state,
    async stop() {
      if (!state.finished) child.kill();
      await done;
      lines.close();
    },
  };
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isTrustedPage(page) {
  try {
    return ['https://portal.yubico.com', 'https://login.yubico.com'].includes(new URL(page.url()).origin);
  } catch (_) { return false; }
}

async function findHomePage(context) {
  for (const page of [...context.pages()].reverse()) {
    if (page.isClosed() || !page.url().startsWith('https://portal.yubico.com/')) continue;
    if (await page.locator(SELECTORS.enrollmentOpen).isVisible().catch(() => false)) return page;
  }
  return null;
}

async function waitForHomeAfterPasskey(context, worker, deadline) {
  while (Date.now() < deadline) {
    // A failed native submission never triggers a PIN retry in this run.
    const home = await findHomePage(context);
    if (home) return home;
    if (worker?.state.finished && worker.state.code !== 0) {
      throw new Error(worker.state.error || 'Native PIN automation failed. No automatic retry.');
    }
    if (context.pages().every((page) => page.isClosed())) throw new Error('Browser closed during login.');
    await pause(200);
  }
  throw new Error('Login timed out before Enrollment Open appeared. Check touch, account/device chooser, or PIN rejection.');
}

async function loginWithPasskey(page, { pin, manualPin = false } = {}) {
  const context = page.context();
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  let clickedLogin = false;
  while (Date.now() < deadline) {
    const home = await findHomePage(context);
    if (home) {
      console.log('[LOGIN] Authenticated Home detected; no PIN entry needed.');
      return home;
    }
    for (const candidate of [...context.pages()].reverse()) {
      if (candidate.isClosed() || !isTrustedPage(candidate)) continue;
      const passkey = candidate.locator(SELECTORS.passkey);
      if (await passkey.isVisible().catch(() => false)) {
        let worker = null;
        let needsManualEntry = manualPin;
        try {
          if (!manualPin) {
            try {
              worker = startPinHelper(pin);
              await worker.ready; // Validate dependencies before displaying the Windows dialog.
            } catch (error) {
              console.warn(`[LOGIN] Native helper startup failed: ${error.message}`);
              if (worker) await worker.stop();
              worker = null;
              needsManualEntry = true;
            }
          }
          await candidate.bringToFront();
          console.log('[LOGIN] Click Sign in with Passkey.');
          if (needsManualEntry) console.log('[LOGIN] Enter PIN manually, then touch the YubiKey when prompted.');
          else console.log('[LOGIN] Attempting native PIN entry once. Touch the YubiKey when prompted.');
          // A Playwright click can remain pending while the native OS dialog is active.
          const clickFailure = passkey.click({ noWaitAfter: true, timeout: LOGIN_TIMEOUT_MS })
            .then(() => new Promise(() => {}));
          let authenticatedPage;
          try {
            authenticatedPage = await Promise.race([
              waitForHomeAfterPasskey(context, worker, deadline), clickFailure,
            ]);
          } catch (error) {
            // Do not retry a PIN: switching modes only permits deliberate human entry.
            if (!worker || !worker.state.finished || worker.state.code === 0) throw error;
            const reason = String(error.message || 'Native PIN helper failed').trim();
            await worker.stop();
            const submitted = worker.state.submissionAttempted;
            worker = null;
            console.warn(`[LOGIN] Native PIN automation unavailable: ${reason}`);
            if (submitted || /rejected|wrong pin|incorrect|blocked|retry warning/i.test(reason)) {
              throw new Error('PIN may have been submitted or rejected. Stopped to avoid extra PIN attempts. ' + reason);
            }
            console.warn('[LOGIN] MANUAL FALLBACK: enter PIN in Windows Security yourself, then touch YubiKey.');
            console.warn('[LOGIN] Browser benchmark will still start only after login succeeds.');
            authenticatedPage = await waitForHomeAfterPasskey(context, null, deadline);
          }
          console.log('[LOGIN] Success: Enrollment Open is visible. Login time is excluded.');
          return authenticatedPage;
        } finally {
          if (worker) await worker.stop();
        }
      }
      const login = candidate.locator(SELECTORS.login);
      if (!clickedLogin && await login.isVisible().catch(() => false)) {
        console.log('[LOGIN] Click Login.');
        await login.click({ noWaitAfter: true });
        clickedLogin = true;
        break;
      }
    }
    await pause(200);
  }
  throw new Error('Login/Passkey controls or authenticated Home were not detected before timeout.');
}


async function waitForLoadedRequests(page, {
  key,
  expectedStart,
  previousFirstRow = null,
  requiredEmail = null,
}) {
  const result = await page.waitForFunction(
    ({ key, expectedStart, previousFirstRow, requiredEmail, quietMs }) => {
      const rows = [...document.querySelectorAll('table tbody tr, [role="row"]')]
        .filter((element) => {
          const isDataRow = element.matches('table tbody tr') ||
            !!element.querySelector('[role="cell"], [role="gridcell"]');
          return isDataRow && element.getClientRects().length > 0;
        })
        .map((element) => (element.innerText || '').trim())
        .filter(Boolean);

      // The portal shows a row range such as "1–15 of 506" or "16–30 of 506".
      const match = (document.body.innerText || '').match(
        /\b(\d+)\s*[\u2013\u2014\-]\s*(\d+)\s+of\s+(\d+)\b/
      );
      const range = match ? {
        start: Number(match[1]), end: Number(match[2]), total: Number(match[3]),
      } : null;

      const valid = !!range &&
        range.start === expectedStart &&
        rows.length > 0 &&
        (!previousFirstRow || rows[0] !== previousFirstRow) &&
        (!requiredEmail || rows.every((row) =>
          row.toLowerCase().includes(requiredEmail.toLowerCase())
        ));

      if (!valid) {
        window.__enrollmentPerfWait = null;
        return false;
      }

      // Prevent recording an intermediate state by observing a brief quiet period.
      const signature = JSON.stringify({ range, rows });
      const now = performance.now();
      const previous = window.__enrollmentPerfWait;
      if (!previous || previous.key !== key || previous.signature !== signature) {
        window.__enrollmentPerfWait = { key, signature, since: now };
        return false;
      }
      if (now - previous.since < quietMs) return false;
      return { ...range, visibleRows: rows.length, firstRow: rows[0] };
    },
    { key, expectedStart, previousFirstRow, requiredEmail, quietMs: QUIET_MS },
    { polling: 50, timeout: WAIT_TIMEOUT_MS },
  );
  return await result.jsonValue();
}

function record(results, label, elapsedMs, state) {
  const rounded = Number(elapsedMs.toFixed(1));
  results.push({ label, elapsedMs: rounded, ...state });
  console.log(
    `[MEASURED] ${label.padEnd(28)} ${rounded.toFixed(1).padStart(8)} ms ` +
    `(${state.start}-${state.end} of ${state.total}, ${state.visibleRows} DOM rows)`
  );
}

function writeCsv(results) {
  const header = 'timestamp,step,duration_ms,range_start,range_end,total_results,visible_dom_rows';
  const timestamp = new Date().toISOString();
  const lines = results.map((r) => [
    timestamp, r.label, r.elapsedMs, r.start, r.end, r.total, r.visibleRows,
  ].join(','));
  fs.writeFileSync(OUTPUT_CSV, `${header}\n${lines.join('\n')}\n`, 'utf8');
  console.log(`\nCSV saved: ${OUTPUT_CSV}`);
}

async function main() {
  const results = [];
  // Parse only FIDO2_PIN from .env. Do not add the secret to process.env:
  // the browser inherits our environment; Python receives PIN over private stdin.
  // For compatibility, an already-supplied FIDO2_PIN is accepted as a fallback.
  const fileVars = fs.existsSync(DOTENV_PATH)
    ? dotenv.parse(fs.readFileSync(DOTENV_PATH))
    : {};
  const pin = fileVars.FIDO2_PIN || process.env.FIDO2_PIN;
  delete process.env.FIDO2_PIN;
  const freshLogin = process.argv.includes('--fresh-login');
  const manualPin = process.argv.includes('--manual-pin');
  // Maximize the native Chromium/Edge window; viewport:null disables Playwright's
  // fixed 1600x900 viewport so the web content follows the window size.
  const browserOptions = { headless: false, args: ['--start-maximized'] };
  if (process.env.BROWSER_CHANNEL) browserOptions.channel = process.env.BROWSER_CHANNEL;
  let browser = null;
  let context = null;
  let page = null;
  let authenticated = false;
  try {
    if (freshLogin) {
      browser = await chromium.launch(browserOptions);
      context = await browser.newContext({ viewport: null });
    } else {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        ...browserOptions, viewport: null,
      });
    }
    context.setDefaultTimeout(WAIT_TIMEOUT_MS);
    page = context.pages()[0] || await context.newPage();
    page = await loginWithPasskey(page, { pin, manualPin });
    authenticated = true;
    const openButton = page.locator(SELECTORS.enrollmentOpen);

    // 1. Click Enrollment > Open -> wait for page 1 and request rows to be ready.
    let start = performance.now();
    await openButton.click();
    const firstPage = await waitForLoadedRequests(page, {
      key: 'open-enrollment', expectedStart: 1,
    });
    record(results, '1. Open Enrollment', performance.now() - start, firstPage);

    // 2. Click Next -> ensure page range updates AND the first row changes.
    if (firstPage.end >= firstPage.total) {
      throw new Error('There is no second page; at least two pages are required for this scenario.');
    }
    const nextButton = page.locator(SELECTORS.nextPage);
    await nextButton.waitFor({ state: 'visible' });
    start = performance.now();
    await nextButton.click();
    const secondPage = await waitForLoadedRequests(page, {
      key: 'next-page', expectedStart: firstPage.end + 1,
      previousFirstRow: firstPage.firstRow,
    });
    record(results, '2. Next page', performance.now() - start, secondPage);

    // 3. Search -> ensure range returns to page 1 and every
    // rendered data row contains the searched email.
    const searchBox = page.locator(SELECTORS.search);
    await searchBox.waitFor({ state: 'visible' });
    start = performance.now();
    await searchBox.fill(SEARCH_EMAIL);
    const filteredPage = await waitForLoadedRequests(page, {
      key: 'search-email', expectedStart: 1,
      requiredEmail: SEARCH_EMAIL,
    });
    record(results, '3. Search email', performance.now() - start, filteredPage);

    writeCsv(results);
  } catch (error) {
    console.error('\n[FAIL] Performance test failed:', error.message);
    try {
      if (!authenticated || !page) throw new Error('No screenshots during authentication.');
      const screenshot = path.join(__dirname, 'enrollment-performance-error.png');
      await page.screenshot({ path: screenshot, fullPage: true });
      console.error(`Screenshot saved: ${screenshot}`);
    } catch (_) { /* Page may have been closed or navigated away. */ }
    if (results.length) writeCsv(results);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { SELECTORS, waitForLoadedRequests, loginWithPasskey, findHomePage, isTrustedPage };
