// Offline control-flow checks with fake Playwright pages. Not a browser/E2E test.
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'playwright') return { chromium: {} };
  // Dependency is installed via npm install in the real project. No network is needed for offline mocks.
  if (request === 'dotenv') return { parse: () => ({}) };
  return originalLoad.call(this, request, ...rest);
};
const { loginWithPasskey, isTrustedPage, SELECTORS, waitForLoadedRequests } =
  require('../enrollment-performance.js');
Module._load = originalLoad;

function fixture(initial = 'login', usePopup = false) {
  const calls = [];
  const pages = [];
  const context = { pages: () => pages };
  function makePage(state) {
    const page = {
      state,
      context: () => context,
      isClosed: () => false,
      url() { return this.state === 'passkey' ? 'https://login.yubico.com/auth' : 'https://portal.yubico.com/'; },
      async goto() {},
      async bringToFront() {},
      locator(selector) {
        return {
          async isVisible() {
            return (selector === SELECTORS.login && page.state === 'login') ||
              (selector === SELECTORS.passkey && page.state === 'passkey') ||
              (selector === SELECTORS.enrollmentOpen && page.state === 'home');
          },
          async click() {
            calls.push(selector);
            if (selector === SELECTORS.login) {
              if (usePopup) { page.state = 'waiting'; pages.push(makePage('passkey')); }
              else page.state = 'passkey';
            } else if (selector === SELECTORS.passkey) page.state = 'home';
          },
        };
      },
    };
    return page;
  }
  pages.push(makePage(initial));
  return { page: pages[0], calls, pages };
}

async function run() {
  const flow = fixture();
  const home = await loginWithPasskey(flow.page, { manualPin: true });
  assert.equal(home.state, 'home');
  assert.deepEqual(flow.calls, [SELECTORS.login, SELECTORS.passkey]);

  const signedIn = fixture('home');
  await loginWithPasskey(signedIn.page, { manualPin: true });
  assert.deepEqual(signedIn.calls, []);

  const alreadyAtPasskey = fixture('passkey');
  await loginWithPasskey(alreadyAtPasskey.page, { manualPin: true });
  assert.deepEqual(alreadyAtPasskey.calls, [SELECTORS.passkey]);

  const popup = fixture('login', true);
  const popupHome = await loginWithPasskey(popup.page, { manualPin: true });
  assert.equal(popupHome, popup.pages[1]);
  assert.equal(isTrustedPage({ url: () => 'https://portal.yubico.com.evil.test/' }), false);
  assert.equal(isTrustedPage({ url: () => 'https://login.yubico.com/auth' }), true);

  // Execute the real DOM readiness predicate against a minimal synthetic document.
  // This tests the predicate, not actual rendering or the live portal's markup.
  global.window = {};
  const email = 'dat.le_ext@yubico.com';
  const row = (text) => ({ matches: () => true, getClientRects: () => [1], innerText: text });
  global.document = { querySelectorAll: () => [row('request-1 ' + email)], body: { innerText: '1-15 of 31' } };
  const fakePage = {
    async waitForFunction(callback, args) {
      assert.equal(callback(args), false, 'Must not finish at first matching sample');
      await new Promise((resolve) => setTimeout(resolve, 260));
      const result = callback(args);
      assert.equal(result.start, 1);
      assert.equal(result.total, 31);
      return { jsonValue: async () => result };
    },
  };
  const state = await waitForLoadedRequests(fakePage, { key: 'search-test', expectedStart: 1, requiredEmail: email });
  assert.equal(state.visibleRows, 1);
  delete global.document;
  delete global.window;
  console.log('Offline JS checks passed: login, reused session, direct passkey, popup, origin guards, readiness predicate.');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
