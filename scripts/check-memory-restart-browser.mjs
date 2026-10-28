// Real process restart and browser-only archive regression. No room/network responses are mocked.
// Run after npm run build; optional PLAYWRIGHT_MODULE and CHROME_PATH select local browser tools.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

let phase = 'setup';
let service;
let browser;
const contexts = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const posts = [];
const frames = [];
const errors = [];
const socketCounts = new WeakMap();
const metadataCounts = new WeakMap();
const check = (value, message) => assert.ok(value, message);
async function step(name, run) {
  phase = name;
  await run();
  check(errors.length === 0, 'Unexpected browser error');
  console.log(`PASS ${name}`);
}
async function stopService() {
  if (!service || service.exitCode !== null || service.signalCode !== null) return;
  const child = service;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { await exited; } finally { clearTimeout(deadline); }
  check(child.exitCode === 0, 'Service did not shut down cleanly');
}
try {
  const portProbe = net.createServer();
  await new Promise((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(0, '127.0.0.1', resolve); });
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const startService = async () => {
    const env = { ...process.env, NODE_ENV: 'production', PORT: String(port) };
    for (const key of Object.keys(env)) {
      if (/^(?:TCB_|CLOUDBASE_|STORAGE_DRIVER$|CHAT_DATA_FILE$)/.test(key)) delete env[key];
    }
    service = spawn(process.execPath, ['apps/server/dist/index.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    service.stdout.resume(); service.stderr.resume();
    let spawnError;
    service.once('error', error => { spawnError = error; });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      check(service.exitCode === null, 'Service exited before readiness');
      try { if ((await fetch(`${origin}/readyz`)).ok) return; } catch { /* startup */ }
      await delay(100);
    }
    throw new Error('Service readiness timed out');
  };
  await startService();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  async function newPage() {
    const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block', acceptDownloads: true });
    contexts.push(context); context.setDefaultTimeout(20000);
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    socketCounts.set(page, 0); metadataCounts.set(page, 0);
    page.on('pageerror', error => errors.push(error.name));
    page.on('request', request => {
      if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
      if (request.method() === 'GET' && /^\/api\/rooms\/[^/]+$/.test(new URL(request.url()).pathname)) metadataCounts.set(page, metadataCounts.get(page) + 1);
    });
    page.on('websocket', socket => {
      socketCounts.set(page, socketCounts.get(page) + 1);
      socket.on('framesent', ({ payload }) => frames.push(String(payload)));
    });
    return page;
  }
  const a = await newPage(), b = await newPage();
  let roomId;
  const messages = [`restart-A-${crypto.randomUUID()}`, `restart-B-${crypto.randomUUID()}`];
  const ready = p => p.locator('.room-subtitle').filter({ hasText: '对方在线' }).waitFor();
  const credentials = p => p.evaluate(id => {
    const session = localStorage.getItem(`elm-chat:session:${id}`);
    return { session, identity: localStorage.getItem(`elm-chat:identity:${id}:${session}`), recovery: localStorage.getItem(`elm-chat:reconnect:${id}:${session}`) };
  }, roomId);
  let priorCredentials;
  await step('production memory service supports two-party encrypted chat without database credentials', async () => {
    await a.goto(origin);
    await a.getByRole('button', { name: '创建聊天房间', exact: true }).click();
    await a.waitForURL(/\/c\//);
    roomId = new URL(a.url()).pathname.split('/').pop();
    await a.getByRole('button', { name: '邀请', exact: true }).click();
    const invite = await a.locator('#invite-link').inputValue();
    await b.goto(invite);
    await Promise.all([ready(a), ready(b)]);
    for (const [from, to, message] of [[a, b, messages[0]], [b, a, messages[1]]]) {
      await from.locator('.composer textarea').fill(message);
      await from.locator('.composer button.primary-button').click();
      await to.locator('.bubble p').filter({ hasText: message }).waitFor();
    }
    check(messages.every(message => frames.every(frame => !frame.includes(message))), 'Plaintext leaked into relay frames');
    check(frames.some(frame => frame.includes('ciphertext')), 'Encrypted frames were not observed');
    priorCredentials = await Promise.all([credentials(a), credentials(b)]);
    check(priorCredentials.every(value => value.session && value.identity && value.recovery), 'Browser recovery credentials missing');
  });
  await step('offline pending message stays in the original browser history', async () => {
    await a.context().setOffline(true);
    await a.locator('.room-subtitle').filter({ hasText: /Reconnect|Disconnected|重新|连接|断开/ }).waitFor();
    const pending = `pending-old-room-${crypto.randomUUID()}`;
    messages.push(pending);
    await a.locator('.composer textarea').fill(pending);
    // The normal submit handler saves locally even though the disconnected send
    // button is disabled. Invoke that real handler without mocking storage.
    await a.locator('.composer').evaluate(form => form.requestSubmit());
    await a.locator('.outbox-status').filter({ hasText: '1 条消息待发送' }).waitFor();
    await a.locator('.bubble p').filter({ hasText: pending }).waitFor();
  });
  await step('real SIGTERM restart invalidates old rooms and stops reconnecting without erasing browser state', async () => {
    await stopService();
    await startService();
    await a.context().setOffline(false);
    assert.equal((await fetch(`${origin}/api/rooms/${roomId}`)).status, 404);
    for (const p of [a, b]) await p.getByRole('heading', { name: 'Room gone', exact: true }).waitFor();
    assert.deepEqual(await Promise.all([credentials(a), credentials(b)]), priorCredentials);
    const socketsBefore = [socketCounts.get(a), socketCounts.get(b)];
    const metadataBefore = [metadataCounts.get(a), metadataCounts.get(b)];
    await delay(9000);
    assert.deepEqual([socketCounts.get(a), socketCounts.get(b)], socketsBefore);
    assert.deepEqual([metadataCounts.get(a), metadataCounts.get(b)], metadataBefore);
    for (const p of [a, b]) {
      await p.getByRole('button', { name: '查看本地记录', exact: true }).click();
      await p.locator('.room-subtitle').filter({ hasText: '仅本地记录' }).waitFor();
      for (const message of messages.slice(0, 2)) await p.locator('.bubble p').filter({ hasText: message }).waitFor();
      if (p === a) await p.locator('.bubble p').filter({ hasText: messages[2] }).waitFor();
      check(await p.locator('.composer textarea').isDisabled(), 'Old room still accepts typing');
      check(await p.locator('.composer button.primary-button').isDisabled(), 'Old room still allows sending');
    }
  });
  await step('expired-room archive export and import stay local and deduplicate the original messages', async () => {
    const postCount = posts.length;
    const password = `temporary-${crypto.randomUUID()}`;
    await a.getByRole('button', { name: '更多功能', exact: true }).click();
    await a.getByRole('menuitem', { name: '导出记录' }).click();
    let dialog = a.getByRole('dialog', { name: '导出记录', exact: true });
    await dialog.getByLabel('设置密码', { exact: true }).fill(password);
    await dialog.getByLabel('再次输入密码', { exact: true }).fill(password);
    const downloading = a.waitForEvent('download');
    await dialog.getByRole('button', { name: '加密并导出', exact: true }).click();
    const download = await downloading;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const archive = Buffer.concat(chunks);
    await download.delete();
    check(archive.length > 0, 'Archive download was empty');
    check(messages.every(message => !archive.includes(Buffer.from(message))), 'Archive contains plaintext');
    const bubbleCount = await a.locator('.bubble').count();
    await a.getByRole('button', { name: '更多功能', exact: true }).click();
    await a.getByRole('menuitem', { name: '导入记录' }).click();
    dialog = a.getByRole('dialog', { name: '导入记录', exact: true });
    await dialog.getByLabel('记录文件').setInputFiles({ name: 'memory-only.achat', mimeType: 'application/octet-stream', buffer: archive });
    await dialog.getByLabel('输入密码', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: '解密并导入', exact: true }).click();
    await a.getByText('已导入 0 条记录，重复记录已跳过。导入内容仅在本机显示。', { exact: true }).waitFor();
    assert.equal(await a.locator('.bubble').count(), bubbleCount);
    assert.equal(posts.length, postCount, 'Archive processing uploaded data');
    assert.deepEqual(await Promise.all([credentials(a), credentials(b)]), priorCredentials);
  });
  await step('new room works after restart and never inherits old messages or pending sends', async () => {
    await a.getByRole('link', { name: '创建新房间', exact: true }).click();
    await a.getByRole('button', { name: '创建聊天房间', exact: true }).click();
    await a.waitForURL(/\/c\//);
    check(new URL(a.url()).pathname.split('/').pop() !== roomId, 'Room identifier was reused');
    await a.getByRole('button', { name: '邀请', exact: true }).click();
    const invite = await a.locator('#invite-link').inputValue();
    await b.goto(invite);
    await Promise.all([ready(a), ready(b)]);
    assert.equal(await a.locator('.bubble').count(), 0);
    assert.equal(await b.locator('.bubble').count(), 0);
    const fresh = `new-room-${crypto.randomUUID()}`;
    await a.locator('.composer textarea').fill(fresh);
    await a.locator('.composer button.primary-button').click();
    await b.locator('.bubble p').filter({ hasText: fresh }).waitFor();
    for (const p of [a, b]) for (const message of messages) assert.equal(await p.locator('.bubble p').filter({ hasText: message }).count(), 0);
  });
  console.log(`PASS memory restart regression (${browser.version()}); no chat or capability artifacts retained`);
} catch (error) {
  console.error(`FAIL ${phase} (${error?.name || 'Error'}); private URLs and contents suppressed`);
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => { process.exitCode = 1; });
  await browser?.close().catch(() => { process.exitCode = 1; });
  await stopService().catch(() => { process.exitCode = 1; });
}
