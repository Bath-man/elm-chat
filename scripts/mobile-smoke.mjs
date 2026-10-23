// Optional browser test tool; does not add a runtime dependency.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.TEST_ORIGIN || 'http://localhost:3000';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const results = [];
const contexts = [];
const check = (name) => { results.push(name); console.log(`PASS ${name}`); };
const waitText = (page, text) => page.getByText(text, { exact: true }).first().waitFor({ timeout: 20000 });
async function context() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (process.env.TEST_NO_RANDOM_UUID === "1") {
    await ctx.addInitScript(() => Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined, configurable: true }));
  }
  await ctx.addInitScript(() => {
    window.__outgoing = []; window.__incoming = []; window.__sockets = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); window.__sockets.push(this); this.addEventListener('message', event => window.__incoming.push(String(event.data))); }
      send(data) { window.__outgoing.push(String(data)); return super.send(data); }
    };
  });
  contexts.push(ctx); return ctx;
}
async function text(page, value) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(value);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}
async function notice(page, value, color) {
  await page.getByRole('button', { name: '更多功能' }).click();
  const dialog = page.getByRole('dialog', { name: '发送互动' });
  await dialog.getByLabel('提醒文字').fill(value);
  await dialog.getByLabel('自定义颜色（HEX）').fill(color);
  await dialog.getByRole('button', { name: '发送', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
try {
  const a = await (await context()).newPage();
  const b = await (await context()).newPage();
  a.on('pageerror', e => console.error('PAGE A', e)); b.on('pageerror', e => console.error('PAGE B', e));
  await a.goto(origin);
  await a.getByRole('button', { name: '创建聊天房间' }).click();
  await a.waitForURL(/\/c\//);
  await a.getByRole('button', { name: '邀请', exact: true }).click();
  const invite = await a.locator('#invite-link').inputValue();
  await b.goto(invite);
  await waitText(a, '对方在线 · 端到端加密');
  await waitText(b, '对方在线 · 端到端加密');
  assert.equal(await a.locator('.bubble').count(), 0);
  assert.equal(await b.locator('.bubble').count(), 0);
  check('two independent mobile sessions join via invite; no demo messages');
  const routedCheck = a.waitForResponse(response => new URL(response.url()).pathname === '/api/runtime' && response.status() === 200);
  await a.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await routedCheck;
  check('visible room checks the same-origin runtime route for deployment handoff');
  await text(a, '双端文字测试'); await waitText(b, '双端文字测试');
  await text(b, '收到文字'); await waitText(a, '收到文字');
  check('real-time two-way text');
  await notice(a, '吃饭提醒', '#123456');
  let prompt = b.getByRole('dialog', { name: '收到提醒' });
  await prompt.waitFor();
  assert.equal(await prompt.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(18, 52, 86)');
  assert.deepEqual(await prompt.evaluate(el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })), { w: 390, h: 844 });
  check('notice automatically opens full-screen with custom HEX background');
  await b.reload();
  prompt = b.getByRole('dialog', { name: '收到提醒' });
  await prompt.waitFor();
  await waitText(b, '对方在线 · 端到端加密');
  check('unconfirmed notice restored after refresh');
  await prompt.getByRole('button', { name: '确认', exact: true }).click();
  await prompt.waitFor({ state: 'hidden' }); await waitText(a, '√');
  assert.equal(await a.locator('.bubble.answer').count(), 1);
  check('notice confirmation sends one green-bordered √');
  await notice(a, '排队提醒', '#fff2a8');
  await b.getByRole('dialog', { name: '收到提醒' }).waitFor();
  await a.getByRole('button', { name: '更多功能' }).click();
  let composer = a.getByRole('dialog', { name: '发送互动' });
  await composer.getByRole('button', { name: '单选调查', exact: true }).click();
  await composer.getByLabel('调查问题').fill('今晚吃什么？');
  await composer.getByLabel('选项 1').fill('米饭'); await composer.getByLabel('选项 2').fill('面条');
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await composer.waitFor({ state: 'hidden' });
  await b.getByRole('dialog', { name: '收到提醒' }).getByRole('button', { name: '确认', exact: true }).click();
  prompt = b.getByRole('dialog', { name: '收到调查' }); await prompt.waitFor();
  const replayEvent = await b.evaluate(() => [...window.__incoming].reverse().find(value => {
    const p = JSON.parse(value); return p.type === 'peer_data' && p.data?.payload?.type === 'chat_message';
  }));
  assert(replayEvent, 'No encrypted poll event captured');
  await b.reload();
  prompt = b.getByRole('dialog', { name: '收到调查' }); await prompt.waitFor();
  await waitText(b, '对方在线 · 端到端加密');
  await prompt.getByLabel('面条', { exact: true }).check();
  await prompt.getByRole('button', { name: '提交', exact: true }).click();
  await prompt.waitFor({ state: 'hidden' });
  await a.locator('.bubble.answer').filter({ hasText: '面条' }).waitFor();
  check('queued poll opens automatically and selection returns as green-bordered answer');
  // Replay the exact authenticated relay event after a successful response.
  await b.evaluate(data => {
    window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', { data }));
  }, replayEvent);
  await b.waitForTimeout(500);
  assert.equal(await b.getByRole('dialog').count(), 0);
  assert.equal(await a.locator('.bubble.answer').count(), 3);
  check('replayed event creates no repeated popup or reply');
  const outgoing = await a.evaluate(() => window.__outgoing.filter(value => JSON.parse(value).data?.payload?.type === 'chat_message'));
  assert(outgoing.length >= 4);
  for (const data of outgoing) {
    assert(!data.includes('双端文字测试') && !data.includes('吃饭提醒') && !data.includes('#123456') && !data.includes('今晚吃什么'));
    const envelope = JSON.parse(data).data.payload.envelope;
    assert(envelope.ciphertext && envelope.nonce && envelope.protocolVersion === 3);
  }
  check('captured WebSocket text and interactions are ciphertext, protocol v3 unchanged');
  const countA = await a.locator('.bubble').count(); const countB = await b.locator('.bubble').count();
  await a.reload(); await b.reload();
  await waitText(a, '对方在线 · 端到端加密'); await waitText(b, '对方在线 · 端到端加密');
  assert.equal(await a.locator('.bubble').count(), countA); assert.equal(await b.locator('.bubble').count(), countB);
  assert.equal(await b.getByRole('dialog').count(), 0);
  check('both histories persist after refresh; completed interactions stay dismissed');
  // Send while peer is offline, then restore key agreement and drain local outbox.
  const guestUrl = b.url();
  await b.goto('about:blank');
  await waitText(a, '等待对方上线 · 端到端加密');
  await text(a, '重连待发送');
  await b.goto(guestUrl);
  await waitText(a, '对方在线 · 端到端加密'); await waitText(b, '重连待发送');
  check('pending message delivered after reconnect/key rotation');
  const overflow = await a.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  await a.setViewportSize({ width: 320, height: 640 });
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await a.setViewportSize({ width: 390, height: 844 });
  await mkdir('artifacts', { recursive: true });
  await a.screenshot({ path: 'artifacts/mobile-chat.png' });
  await notice(a, '退出测试', '#d5f5dc');
  prompt = b.getByRole('dialog', { name: '收到提醒' }); await prompt.waitFor();
  await b.screenshot({ path: 'artifacts/mobile-notice.png' });
  await prompt.getByRole('button', { name: '退出房间', exact: true }).click();
  await b.waitForURL(origin + '/');
  check('320/390px mobile layout and exit from blocking notice');
  console.log(`\n${results.length} browser checks passed.`);
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
