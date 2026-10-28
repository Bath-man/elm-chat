// Real local room recovery regression: no room responses or WebSocket payloads are mocked.
// Run against an already running local server with TEST_ORIGIN and optionally PLAYWRIGHT_MODULE.
import assert from 'node:assert/strict';
import net from 'node:net';

let phase = 'configuration';
let browser;
let proxy;
let forwarding = true;
let creator;
let roomId;
let destroyed = false;
const contexts = [];
const pipes = new Set();
const pageErrors = [];
const socketCounts = new WeakMap();
const check = (value, message = 'Recovery assertion failed') => assert.ok(value, message);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function step(name, run) {
  phase = name;
  await run();
  check(pageErrors.length === 0, 'Unexpected browser error');
  console.log(`PASS ${name}`);
}

try {
  const origin = new URL(process.env.TEST_ORIGIN || 'http://127.0.0.1:5210');
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1');
  check(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/');
  proxy = net.createServer(client => {
    if (!forwarding) return client.destroy();
    const upstream = net.connect({ host: '127.0.0.1', port: Number(origin.port || 80) });
    const pair = { client, upstream };
    pipes.add(pair);
    const dispose = () => { client.destroy(); upstream.destroy(); pipes.delete(pair); };
    client.on('error', dispose); upstream.on('error', dispose);
    client.on('close', dispose); upstream.on('close', dispose);
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const guestOrigin = new URL(`http://127.0.0.1:${proxy.address().port}`);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  async function newPage(allowedOrigin, existingContext) {
    const context = existingContext || await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    if (!existingContext) {
      contexts.push(context);
      context.setDefaultTimeout(20000);
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin !== allowedOrigin.origin || ['/api/stars', '/api/community'].includes(url.pathname)
          ? route.abort() : route.continue();
      });
    }
    const p = await context.newPage();
    await p.addInitScript(() => {
      window.messageEntrances = [];
      document.addEventListener('animationstart', event => {
        if (event.animationName === 'message-enter') window.messageEntrances.push(event.target.dataset.messageId);
      });
    });
    p.on('pageerror', error => {
      pageErrors.push(error.name);
      console.error(`BROWSER ERROR ${(error.stack || error.name).replace(/https?:\/\/\S+/g, '[URL redacted]')}`);
    });
    socketCounts.set(p, 0);
    p.on('websocket', () => socketCounts.set(p, socketCounts.get(p) + 1));
    return p;
  }
  creator = await newPage(origin);
  let guest = await newPage(guestOrigin);
  const ready = p => p.locator('.composer textarea:not([disabled])').waitFor();
  const connected = (p, timeout = 20000) => p.locator('.room-subtitle').filter({ hasText: '对方在线' }).waitFor({ timeout });
  const closed = async p => {
    await p.getByRole('heading', { name: 'Room gone', exact: true }).waitFor();
    check(await p.locator('.composer').count() === 0);
  };
  const identity = p => p.evaluate(id => {
    const session = localStorage.getItem(`elm-chat:session:${id}`) || sessionStorage.getItem(`elm-chat:session:${id}`);
    const stored = localStorage.getItem(`elm-chat:identity:${id}:${session}`) || sessionStorage.getItem(`elm-chat:identity:${id}:${session}`);
    if (!session || !stored) return null;
    const { publicKey, agreementPublicKey } = JSON.parse(stored);
    return { session, publicKey, agreementPublicKey };
  }, roomId);
  async function invite() {
    // The simplified UI disables invitation sharing when both peers are online.
    // Use the same real authenticated endpoint to test full-room enforcement.
    const token = await creator.evaluate(async id => {
      const response = await fetch(`/api/rooms/${id}/invites`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorToken: localStorage.getItem(`elm-chat:creator:${id}`) })
      });
      if (!response.ok) throw new Error('Invite creation failed');
      return (await response.json()).token;
    }, roomId);
    const url = new URL(creator.url());
    url.search = new URLSearchParams({ invite: token }).toString();
    return url.href;
  }
  async function send(from, to, text) {
    await from.locator('.composer textarea').fill(text);
    await from.locator('.composer button.primary-button').click();
    const remote = to.locator('.bubble-theirs p').filter({ hasText: text });
    await remote.waitFor();
    check(await remote.count() === 1 && await remote.innerText() === text);
    for (const p of [from, to]) {
      const article = p.locator('.bubble').filter({ has: p.locator('p', { hasText: text }) });
      const id = await article.getAttribute('data-message-id');
      await p.waitForFunction(id => window.messageEntrances.includes(id), id);
      check(await p.evaluate(id => window.messageEntrances.filter(value => value === id).length, id) === 1,
        'Message entrance replayed');
    }
    check(await from.locator('.composer textarea').evaluate(element => document.activeElement === element),
      'Sending stole composer focus');
  }
  let usedInvite;
  let freshInvite;
  const baseline = [];
  let creatorIdentity;
  let guestIdentity;
  let roomUrl;
  await step('A creates room and B joins one-time invite', async () => {
    phase = 'A opens landing';
    await creator.goto(origin.href);
    await creator.getByRole('button', { name: '创建聊天房间', exact: true }).click();
    phase = 'A waits for room composer';
    await ready(creator);
    roomId = new URL(creator.url()).pathname.split('/').pop();
    check(roomId);
    phase = 'A creates invitations';
    usedInvite = await invite();
    freshInvite = await invite();
    const target = new URL(usedInvite);
    target.host = guestOrigin.host;
    phase = 'B opens invite';
    await guest.goto(target.href);
    phase = 'A and B await connected presence';
    await Promise.all([connected(creator), connected(guest)]);
    await Promise.all([ready(creator), ready(guest)]);
    roomUrl = guest.url();
    creatorIdentity = await identity(creator);
    guestIdentity = await identity(guest);
    check(creatorIdentity?.publicKey && guestIdentity?.publicKey);
    check(creatorIdentity.session !== guestIdentity.session);
    phase = 'persistent member recovery credentials exist';
    for (const p of [creator, guest]) {
      check(await p.evaluate(id => {
        const session = localStorage.getItem(`elm-chat:session:${id}`);
        const token = localStorage.getItem(`elm-chat:reconnect:${id}:${session}`);
        return Boolean(token && token.length >= 32 && token !== 'undefined');
      }, roomId), 'Missing persistent member recovery credential');
    }
  });
  await step('encrypted chat in both directions', async () => {
    for (const [from, to] of [[creator, guest], [guest, creator]]) {
      const text = `Recovery baseline ${crypto.randomUUID()}`;
      await send(from, to, text);
      baseline.push(text);
    }
  });
  await step('A and B reload retaining identities and local history', async () => {
    for (const [p, before] of [[creator, creatorIdentity], [guest, guestIdentity]]) {
      phase = p === creator ? 'A refresh restores presence' : 'B refresh restores presence';
      await p.reload();
      await Promise.all([connected(creator), connected(guest)]);
      assert.deepEqual(await identity(p), before);
      for (const text of baseline) check(await p.locator('.bubble p').filter({ hasText: text }).count() === 1);
      check(await p.locator('.bubble-enter').count() === 0, 'Restored history animated');
      check(await p.evaluate(() => window.messageEntrances.length) === 0, 'History replayed entrance');
    }
  });
  await step('B closes page and reopens with fresh sessionStorage', async () => {
    const context = guest.context();
    await guest.close();
    // A new pending message animates once now, not again when the outbox drains.
    await creator.locator('.room-subtitle').filter({ hasText: '等待对方上线' }).waitFor();
    const pending = `Outbox motion ${crypto.randomUUID()}`;
    await creator.locator('.composer textarea').fill(pending);
    await creator.locator('.composer button.primary-button').click();
    await creator.locator('.bubble p').filter({ hasText: pending }).waitFor();
    baseline.push(pending);
    guest = await newPage(guestOrigin, context);
    await guest.goto(guestOrigin.href);
    check(await guest.evaluate(() => sessionStorage.length) === 0);
    await guest.goto(roomUrl);
    await Promise.all([connected(creator), connected(guest)]);
    assert.deepEqual(await identity(guest), guestIdentity);
    for (const text of baseline) await guest.locator('.bubble p').filter({ hasText: text }).waitFor();
    await creator.waitForFunction(() => !document.querySelector('.outbox-status'));
    for (const p of [creator, guest]) {
      check(await p.evaluate(async () => {
        const request = indexedDB.open('elm-chat-history');
        const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = reject; });
        const read = db.transaction('messages').objectStore('messages').getAll();
        const records = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = reject; });
        db.close();
        return records.every(record => !Object.hasOwn(record, 'entrance'));
      }), 'UI animation marker leaked into saved history');
    }
  });
  await step('third browser cannot reuse old or fresh invite in full room', async () => {
    for (const [url, spoofMember] of [[usedInvite, false], [freshInvite, false], [freshInvite, true]]) {
      const visitor = await newPage(origin);
      if (spoofMember) {
        await visitor.goto(origin.href);
        // Knowledge of the original member ID alone must not grant recovery.
        await visitor.evaluate(({ id, session }) => {
          localStorage.setItem(`elm-chat:session:${id}`, session);
          sessionStorage.setItem(`elm-chat:session:${id}`, session);
        }, { id: roomId, session: guestIdentity.session });
      }
      await visitor.goto(url);
      await visitor.locator('.access-screen').waitFor();
      await visitor.waitForFunction(() => /already|two participants|used|claimed|full|could not be verified|credential is required/i.test(document.querySelector('.access-screen')?.textContent || ''));
      check(await visitor.locator('.composer').count() === 0);
      await visitor.close();
    }
    await Promise.all([connected(creator), connected(guest)]);
  });
  await step('real transport cuts recover without duplicate members or events', async () => {
    for (let round = 0; round < 4; round += 1) {
      // Presence is confirmed by the peer after severing existing TCP streams.
      forwarding = false;
      for (const { client, upstream } of pipes) { client.destroy(); upstream.destroy(); }
      await creator.locator('.room-subtitle').filter({ hasText: '等待对方上线' }).waitFor();
      if (round >= 2) {
        // Both long cuts exhaust fast backoff. Round 2 restores only transport,
        // with no browser online event; round 3 also exercises the online event.
        if (round === 3) await guest.context().setOffline(true);
        await delay(35000);
      } else await delay(500);
      forwarding = true;
      if (round === 3) await guest.context().setOffline(false);
      await Promise.all([connected(creator, 45000), connected(guest, 45000)]);
      assert.deepEqual(await identity(guest), guestIdentity);
      await send(guest, creator, `Recovered round ${round} ${crypto.randomUUID()}`);
      const settledSockets = socketCounts.get(guest);
      await delay(1500);
      check(socketCounts.get(guest) === settledSockets, 'Connection restarted after successful recovery');
    }
    for (const p of [creator, guest]) check(await p.locator('.room-error').count() === 0);
  });
  await step('destroyed room rejects old recovery credentials', async () => {
    const status = await creator.evaluate(async id => {
      const response = await fetch(`/api/rooms/${id}/destroy`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorToken: localStorage.getItem(`elm-chat:creator:${id}`) })
      });
      return response.status;
    }, roomId);
    check(status === 200);
    destroyed = true;
    await Promise.all([closed(creator), closed(guest)]);
    // The saved local session remains intact. Reload must not readmit either member.
    for (const p of [creator, guest]) { await p.reload(); await closed(p); }
    const visitor = await newPage(origin);
    await visitor.goto(freshInvite);
    await closed(visitor);
    await delay(1500);
    for (const p of [creator, guest, visitor]) check(await p.locator('.composer').count() === 0);
  });
  await step('closed room keeps local history and export available without reconnecting', async () => {
    const before = await identity(guest);
    check(before?.session === guestIdentity.session, 'Closing erased the saved session');
    await guest.getByRole('button', { name: '查看本地记录', exact: true }).click();
    await guest.locator('.room-subtitle').filter({ hasText: '仅本地记录' }).waitFor();
    check(await guest.locator('.bubble').count() > 0, 'Local messages disappeared');
    check(await guest.locator('.composer textarea').isDisabled());
    await guest.getByRole('button', { name: '更多功能', exact: true }).click();
    await guest.getByRole('menuitem', { name: '导出记录' }).click();
    await guest.getByRole('dialog', { name: '导出记录', exact: true }).waitFor();
    const count = socketCounts.get(guest);
    await delay(2000);
    check(socketCounts.get(guest) === count, 'Closed room continued reconnecting');
  });
  await step('missing room stops recovery and retains browser credentials', async () => {
    const missing = await newPage(origin);
    const id = `missing-${Date.now()}`;
    const session = crypto.randomUUID();
    const recovery = 'a'.repeat(43);
    await missing.goto(origin.href);
    await missing.evaluate(({ id, session, recovery }) => {
      localStorage.setItem(`elm-chat:session:${id}`, session);
      localStorage.setItem(`elm-chat:reconnect:${id}:${session}`, recovery);
    }, { id, session, recovery });
    await missing.goto(`${origin.origin}/c/${id}#${new URL(creator.url()).hash.slice(1)}`);
    await closed(missing);
    check((await missing.locator('.access-copy').allTextContents()).some(text => text.includes('restart')));
    const count = socketCounts.get(missing);
    await delay(2000);
    check(socketCounts.get(missing) === count);
    check(await missing.evaluate(({ id, session, recovery }) =>
      localStorage.getItem(`elm-chat:session:${id}`) === session &&
      localStorage.getItem(`elm-chat:reconnect:${id}:${session}`) === recovery,
    { id, session, recovery }), 'Missing room erased browser credentials');
    await missing.getByRole('button', { name: '查看本地记录', exact: true }).click();
    check(await missing.locator('.composer textarea').isDisabled());
    await missing.getByRole('button', { name: '更多功能', exact: true }).click();
    await missing.getByRole('menuitem', { name: '导入记录' }).click();
    await missing.getByRole('dialog', { name: '导入记录', exact: true }).waitFor();
  });
  console.log(`PASS room recovery regression (${browser.version()}); no capability artifacts saved`);
} catch (error) {
  // Playwright errors can contain private invite URLs, so only print safe context.
  for (let i = 0; i < contexts.length; i += 1) {
    for (const p of contexts[i].pages()) {
      const credential = await p.evaluate(id => {
        const session = localStorage.getItem(`elm-chat:session:${id}`);
        return { hasSession: Boolean(session), tokenLength: localStorage.getItem(`elm-chat:reconnect:${id}:${session}`)?.length ?? 0 };
      }, roomId).catch(() => null);
      console.error(`CREDENTIAL context ${i}: ${JSON.stringify(credential)}`);
      const state = await p.locator('.room-error, .access-copy, .room-subtitle').allTextContents().catch(() => []);
      console.error(`STATE context ${i}: ${JSON.stringify(state).replace(/https?:\/\/[^\s"\]]+/g, '[URL redacted]')}`);
    }
  }
  console.error(`FAIL ${phase} (${error?.name || 'Error'}); details suppressed to protect local capabilities`);
  process.exitCode = 1;
} finally {
  forwarding = true;
  if (creator && roomId && !destroyed) {
    try {
      await creator.evaluate(async id => fetch(`/api/rooms/${id}/destroy`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorToken: localStorage.getItem(`elm-chat:creator:${id}`) })
      }), roomId);
    } catch { /* Best effort cleanup of this local test room only. */ }
  }
  for (const context of contexts) await context.close().catch(() => { process.exitCode = 1; });
  await browser?.close().catch(() => { process.exitCode = 1; });
  for (const { client, upstream } of pipes) { client.destroy(); upstream.destroy(); }
  if (proxy?.listening) await new Promise(resolve => proxy.close(resolve));
}
