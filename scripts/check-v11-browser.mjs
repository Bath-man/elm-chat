// Optional local integration check: use an existing Playwright installation.
// TEST_ORIGIN=http://localhost:3000 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-v11-browser.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.TEST_ORIGIN || 'http://localhost:3000';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const contexts = [];
const errors = [];
let passed = 0;
const check = name => { passed += 1; console.log(`PASS ${name}`); };
const waitText = (page, text) => page.getByText(text, { exact: true }).first().waitFor({ timeout: 20000 });
const bubble = (page, text) => page.locator('.bubble').filter({ hasText: text });
async function session() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  contexts.push(context);
  await context.addInitScript(() => {
    window.__v11Incoming = []; window.__v11Outgoing = []; window.__v11Sockets = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args); window.__v11Sockets.push(this);
        this.addEventListener('message', event => window.__v11Incoming.push(String(event.data)));
      }
      send(data) { window.__v11Outgoing.push(String(data)); return super.send(data); }
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  return page;
}
async function sendText(page, text) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}
async function compose(page, kind) {
  await page.getByRole('button', { name: '更多功能' }).click();
  await page.getByRole('menuitem', { name: kind, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '发送互动' });
  if (kind !== '摇骰子') await dialog.waitFor();
  return dialog;
}
async function submit(dialog) {
  await dialog.getByRole('button', { name: /^(发送|保存|保存置顶)$/ }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function countLikes(page, id, value) {
  await page.locator(`[data-message-id="${id}"] .like-count`).filter({ hasText: String(value) }).waitFor();
  assert.equal((await page.locator(`[data-message-id="${id}"] .like-count`).innerText()).replace(/\D/g, ''), String(value));
}
async function lastRelay(page) {
  const value = await page.evaluate(() => [...window.__v11Incoming].reverse().find(raw => {
    try { return JSON.parse(raw).type === 'peer_data' && JSON.parse(raw).data?.payload?.type === 'chat_message'; } catch { return false; }
  }));
  assert(value, 'Expected encrypted chat event');
  return value;
}
async function replay(page, data) {
  await page.evaluate(async raw => {
    window.__v11Sockets.at(-1).dispatchEvent(new MessageEvent('message', { data: raw }));
    // Allow the decrypt/React pipeline to finish without a fixed network sleep.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, data);
}
try {
  const a = await session(); const b = await session();
  await a.goto(origin);
  await a.getByRole('button', { name: '创建聊天房间' }).click();
  await a.waitForURL(/\/c\//);
  await a.getByRole('button', { name: '邀请', exact: true }).click();
  await b.goto(await a.locator('#invite-link').inputValue());
  await waitText(a, '对方在线 · 端到端加密'); await waitText(b, '对方在线 · 端到端加密');
  assert.equal(await a.locator('.bubble').count(), 0);
  check('independent mobile sessions establish encrypted room');

  await sendText(a, 'V11 原文苹果味道'); await bubble(b, 'V11 原文苹果味道').waitFor();
  const id = await bubble(a, 'V11 原文苹果味道').getAttribute('data-message-id');
  assert(id); assert.equal(await bubble(b, 'V11 原文苹果味道').getAttribute('data-message-id'), id);
  await bubble(b, 'V11 原文苹果味道').click({ clickCount: 5, delay: 40 });
  await countLikes(a, id, 5); await countLikes(b, id, 5);
  const likeReplay = await lastRelay(a);
  await replay(a, likeReplay);
  await sendText(b, '点赞去重屏障'); await bubble(a, '点赞去重屏障').waitFor();
  await countLikes(a, id, 5);
  check('five rapid clicks sync exactly five likes; encrypted replay is deduplicated');

  let dialog = await compose(a, '发送提醒');
  await dialog.getByLabel('提醒文字').fill('V11 吃饭提醒');
  await dialog.getByLabel('自定义颜色（HEX）').fill('#123456');
  await submit(dialog);
  let prompt = b.getByRole('dialog', { name: '收到提醒' }); await prompt.waitFor();
  assert.equal(await prompt.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(18, 52, 86)');
  assert.deepEqual(await prompt.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight })), { width: 390, height: 844 });
  const counts = [await a.locator('.bubble').count(), await b.locator('.bubble').count()];
  await prompt.getByRole('button', { name: '确认', exact: true }).click();
  await prompt.waitFor({ state: 'hidden' });
  await a.locator('.bubble.notice.confirmed').waitFor(); await b.locator('.bubble.notice.confirmed').waitFor();
  assert.equal(await a.locator('.bubble').count(), counts[0]); assert.equal(await b.locator('.bubble').count(), counts[1]);
  assert.equal(await a.getByText('√', { exact: true }).count(), 0);
  check('custom full-screen notice confirms original bubbles without generating a reply');

  dialog = await compose(a, '单选调查');
  await dialog.getByLabel('问卷问题').fill('V11 唯一选择');
  await dialog.getByRole('button', { name: '移除末项' }).click();
  await dialog.getByLabel('选项 1', { exact: true }).fill('唯一选项');
  assert.equal(await dialog.getByLabel('选项 2', { exact: true }).count(), 0);
  await submit(dialog);
  prompt = b.getByRole('dialog', { name: '收到调查' }); await prompt.waitFor();
  assert(!await bubble(a, 'V11 唯一选择').innerText().then(text => text.includes('唯一选项')));
  await prompt.getByLabel('唯一选项', { exact: true }).check();
  assert(await prompt.isVisible(), 'Single click must select without submitting');
  await prompt.getByText('唯一选项', { exact: true }).dblclick();
  await prompt.waitFor({ state: 'hidden' });
  await a.locator('.bubble.answer').filter({ hasText: '唯一选项' }).waitFor();
  check('single-option poll hides sender choices; click selects and double click submits');

  dialog = await compose(a, '单选调查');
  await dialog.getByLabel('问卷问题').fill('V11 手机双击');
  await dialog.getByLabel('选项 1', { exact: true }).fill('触屏提交');
  await dialog.getByLabel('选项 2', { exact: true }).fill('其他'); await submit(dialog);
  prompt = b.getByRole('dialog', { name: '收到调查' }); await prompt.waitFor();
  const touchOption = prompt.getByText('触屏提交', { exact: true });
  await touchOption.tap();
  assert(await prompt.isVisible(), 'One touch tap must only select');
  await touchOption.tap();
  await prompt.waitFor({ state: 'hidden' });
  await a.locator('.bubble.answer').filter({ hasText: '触屏提交' }).waitFor();
  check('actual mobile touch taps select then submit poll without mouse dblclick');

  dialog = await compose(a, '置顶气泡');
  await dialog.getByLabel('置顶文字').fill('V11 共享置顶');
  await dialog.getByLabel('自定义颜色（HEX）').fill('#d5f5dc');
  await submit(dialog);
  await a.locator('.pinned-bubble').filter({ hasText: 'V11 共享置顶' }).waitFor();
  await b.locator('.pinned-bubble').filter({ hasText: 'V11 共享置顶' }).waitFor();
  assert.equal(await a.locator('.chat-log .pinned-bubble').count(), 0);
  await b.getByRole('button', { name: '编辑置顶' }).click();
  dialog = b.getByRole('dialog', { name: '发送互动' });
  await dialog.getByLabel('置顶文字').fill('V11 对方编辑置顶'); await submit(dialog);
  await a.locator('.pinned-bubble').filter({ hasText: 'V11 对方编辑置顶' }).waitFor();
  assert.equal(await a.locator('.pinned-bubble').count(), 1);
  check('one shared compact pin is outside scrolling history and editable by peer');

  await compose(a, '摇骰子');
  await a.locator('.bubble-mine .dice-face').waitFor(); await b.locator('.bubble-theirs .dice-face').waitFor();
  const dice = await a.locator('.dice-face').getAttribute('data-value');
  assert(Number(dice) >= 1 && Number(dice) <= 6);
  assert.equal(await b.locator('.dice-face').getAttribute('data-value'), dice);
  check('dice is a normal correctly aligned message with identical 1–6 result');

  dialog = await compose(a, '隐藏信息');
  await dialog.getByLabel('表面文字').fill('V11 表面文字');
  await dialog.getByLabel('隐藏文字').fill('V11 隐藏秘密'); await submit(dialog);
  const hiddenA = bubble(a, 'V11 表面文字'); const hiddenB = bubble(b, 'V11 表面文字'); await hiddenB.waitFor();
  await hiddenB.getByRole('button', { name: '显示隐藏文字', exact: true }).click();
  await bubble(b, 'V11 隐藏秘密').waitFor();
  assert(await hiddenA.isVisible(), 'Peer reveal must not change sender state');
  await bubble(b, 'V11 隐藏秘密').getByRole('button', { name: '显示表面文字', exact: true }).click();
  await hiddenB.waitFor();
  check('hidden text toggles locally without triggering likes or changing peer display');

  const editTarget = b.locator(`[data-message-id="${id}"]`);
  await editTarget.scrollIntoViewIfNeeded();
  const editBox = await editTarget.boundingBox(); assert(editBox);
  await b.mouse.move(editBox.x + editBox.width / 2, editBox.y + editBox.height / 2);
  await b.mouse.down();
  await b.getByRole('button', { name: '涂改', exact: true }).waitFor();
  await b.mouse.up();
  await countLikes(b, id, 5);
  await b.getByRole('button', { name: '涂改', exact: true }).click();
  dialog = b.getByRole('dialog', { name: '涂改消息' }); await dialog.waitFor();
  const original = dialog.getByLabel('选择原文字');
  await original.evaluate(el => { el.focus(); el.setSelectionRange(6, 8); });
  await original.press('Shift');
  assert.equal(await original.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), '苹果');
  await dialog.getByLabel('替换文字').fill('橙子');
  await dialog.getByRole('button', { name: '确认涂改', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await a.locator(`[data-message-id="${id}"] del`).waitFor(); await b.locator(`[data-message-id="${id}"] del`).waitFor();
  assert.equal(await a.locator(`[data-message-id="${id}"] del`).innerText(), '苹果');
  assert((await a.locator(`[data-message-id="${id}"]`).innerText()).includes('橙子'));
  await b.locator(`[data-message-id="${id}"]`).dispatchEvent('contextmenu');
  assert.equal(await b.getByRole('button', { name: '涂改', exact: true }).count(), 0);
  await b.keyboard.press('Escape');
  check('incoming ordinary text is amended once in place with struck original');

  const wire = await a.evaluate(() => window.__v11Outgoing.filter(raw => { try { return JSON.parse(raw).data?.payload?.type === 'chat_message'; } catch { return false; } }));
  assert(wire.length > 5);
  for (const raw of wire) {
    for (const secret of ['V11', '隐藏秘密', '共享置顶', '苹果', '#123456']) assert(!raw.includes(secret), `Plaintext leaked: ${secret}`);
    const envelope = JSON.parse(raw).data.payload.envelope;
    assert(envelope.ciphertext && envelope.nonce && envelope.protocolVersion === 3);
  }
  check('all captured feature traffic uses existing encrypted v3 envelopes');

  const before = [await a.locator('.bubble').count(), await b.locator('.bubble').count()];
  await a.reload(); await b.reload();
  await waitText(a, '对方在线 · 端到端加密'); await waitText(b, '对方在线 · 端到端加密');
  assert.equal(await a.locator('.bubble').count(), before[0]); assert.equal(await b.locator('.bubble').count(), before[1]);
  for (const page of [a, b]) {
    await countLikes(page, id, 5);
    assert.equal(await page.locator(`[data-message-id="${id}"] del`).innerText(), '苹果');
    assert.equal(await page.locator('.dice-face').getAttribute('data-value'), dice);
    await page.locator('.pinned-bubble').filter({ hasText: 'V11 对方编辑置顶' }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.locator('.bubble.notice.confirmed').waitFor();
  }
  check('IndexedDB refresh restores likes, amendments, dice, pin and completed notice without duplicate messages');

  await mkdir('artifacts', { recursive: true });
  for (const width of [320, 390]) {
    await a.setViewportSize({ width, height: width === 320 ? 640 : 844 });
    for (const dark of [false, true]) {
      const toggle = a.getByRole('button', { name: '夜间模式', exact: true });
      if ((await toggle.getAttribute('aria-pressed') === 'true') !== dark) await toggle.click();
      assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const pinBox = await a.locator('.pinned-bubble').boundingBox();
      const logBox = await a.locator('.chat-log').boundingBox();
      assert(pinBox && logBox && pinBox.y + pinBox.height <= logBox.y + 1, 'Pinned bubble must not overlap scrolling history');
      await a.screenshot({ path: `artifacts/v11-${width}-${dark ? 'dark' : 'light'}.png`, animations: 'disabled' });
    }
  }
  check('320/390px light/dark layouts have no horizontal overflow or pin overlap; four screenshots captured');

  const guestUrl = b.url();
  await b.goto('about:blank');
  await waitText(a, '等待对方上线 · 端到端加密');
  const queuedLikeTarget = a.locator(`[data-message-id="${id}"]`);
  // The first pending event adds the outbox status row; retarget each tap after layout settles.
  for (let count = 6; count <= 8; count += 1) {
    await queuedLikeTarget.click();
    await countLikes(a, id, count);
  }
  await a.getByRole('button', { name: '编辑置顶' }).click();
  dialog = a.getByRole('dialog', { name: '发送互动' });
  await dialog.getByLabel('置顶文字').fill('V11 离线恢复置顶'); await submit(dialog);
  await a.locator('.pinned-bubble').filter({ hasText: 'V11 离线恢复置顶' }).waitFor();
  await a.reload(); await waitText(a, '等待对方上线 · 端到端加密');
  await countLikes(a, id, 8);
  await a.locator('.pinned-bubble').filter({ hasText: 'V11 离线恢复置顶' }).waitFor();
  await b.goto(guestUrl);
  await waitText(a, '对方在线 · 端到端加密'); await waitText(b, '对方在线 · 端到端加密');
  for (const page of [a, b]) {
    await countLikes(page, id, 8);
    await page.locator('.pinned-bubble').filter({ hasText: 'V11 离线恢复置顶' }).waitFor();
  }
  check('offline likes and pin survive sender reload, then sync after reconnect and key rotation');
  await a.getByRole('button', { name: '删除置顶' }).click();
  await a.locator('.pinned-bubble').waitFor({ state: 'hidden' }); await b.locator('.pinned-bubble').waitFor({ state: 'hidden' });
  check('pin deletion removes it on both peers');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log(`\n${passed} V1.1 browser checks passed.`);
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
