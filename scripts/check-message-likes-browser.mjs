// Full room UI + real IndexedDB, with a local synthetic transport (no backend).
import assert from 'node:assert/strict';

const origin = new URL(process.env.TEST_ORIGIN || 'http://127.0.0.1:5197');
assert.equal(origin.protocol, 'http:');
assert.equal(origin.hostname, '127.0.0.1');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const room = { roomId: 'likes-test', createdAt: Date.now(), expiresAt: null,
  inactivityTimeoutMs: null, maxAgeMs: null, disappearAfterReadSeconds: null,
  status: 'open', participantCount: 1, creatorJoined: true,
  lastActivityAt: Date.now(), membershipVersion: 1 };

try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ isMobile: mobile, hasTouch: mobile,
      viewport: { width: mobile ? 390 : 1024, height: 844 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route('**/api/**', route => route.fulfill({ status: 200,
        contentType: 'application/json', body: JSON.stringify(
          new URL(route.request().url()).pathname === '/api/rooms/likes-test' ? room : []) }));
      await page.routeWebSocket('**/api/rooms/likes-test/ws', socket => {
        socket.onMessage(raw => {
          const message = JSON.parse(String(raw));
          if (message.type !== 'join') return;
          socket.send(JSON.stringify({ type: 'joined', room, sessionId: message.sessionId,
            creator: false, self: { sessionId: message.sessionId, creator: false,
              connectedAt: 1, identityKey: message.identityKey, agreementKey: message.agreementKey },
            peers: [], presence: { count: 1, connectedSessionIds: [message.sessionId] } }));
        });
      });
      await page.goto(`${origin.origin}/c/likes-test?invite=synthetic#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
      const textarea = page.locator('.composer textarea:not([disabled])');
      await textarea.waitFor();
      await textarea.fill('Repeated like target');
      await page.locator('.composer').evaluate(form => form.requestSubmit());
      const target = page.locator('.bubble');
      await target.waitFor();
      // Drain hundreds of actual click handlers through the serialized storage queue.
      await target.evaluate(element => { for (let index = 0; index < 300; index++) element.click(); });
      await page.waitForFunction(() => document.querySelector('.like-count')?.textContent === '300' ||
        document.querySelector('h1')?.textContent === 'Could not open this session');
      assert.equal(await page.getByText('Could not open this session', { exact: true }).count(), 0,
        'rapid likes must not reach the room error boundary');
      assert.equal(await target.locator('..').locator('.like-count').textContent(), '300');
      await textarea.fill('Keep this draft');
      // Real touch/mouse activation still preserves the composer focus.
      if (mobile) await target.tap(); else await target.click();
      await page.waitForFunction(() => document.querySelector('.like-count')?.textContent === '301');
      assert.equal(await textarea.inputValue(), 'Keep this draft');
      assert.equal(await textarea.evaluate(element => document.activeElement === element), true);
      // Let the heart animations clean up, then ensure the room remains usable.
      await page.waitForFunction(() => document.querySelectorAll('.floating-heart').length === 0);
      await page.reload();
      // Like events also occupy history rows; page back to the original message.
      await page.locator('.composer textarea:not([disabled])').waitFor();
      await page.waitForFunction(() => {
        if (document.querySelector('.like-count')?.textContent === '301') return true;
        // Scrolling may already be loading a page and remove the button.
        const earlier = [...document.querySelectorAll('.chat-log button')]
          .find(button => button.textContent === '加载更早记录');
        earlier?.click();
        return false;
      });
      assert.equal(await page.locator('.bubble').count(), 1);
      assert.deepEqual(errors, [], 'no browser/React errors during rapid likes or restoration');
      console.log(`PASS ${mobile ? 'mobile touch' : 'desktop'}: 301 likes settle, retain draft/focus, clean animations and survive reload`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
