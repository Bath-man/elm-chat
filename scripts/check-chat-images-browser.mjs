// Real local relay + production web build. TEST_ORIGIN must point at a disposable local server.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = new URL(process.env.TEST_ORIGIN || 'http://127.0.0.1:5199');
assert.equal(origin.hostname, '127.0.0.1', 'Only a disposable loopback server may be tested');
assert.equal(origin.protocol, 'http:');
const temporary = await mkdtemp(join(tmpdir(), 'chat-images-browser-'));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
let phase = 'setup';
const errors = [], frames = [];
async function newPage() {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  // Observe bytes passed to the native blob URL API without bypassing the real CSP.
  await context.addInitScript(() => {
    window.__chatImageBlobs = new Map();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.__chatImageBlobs.set(url, blob); return url; };
    URL.revokeObjectURL = url => { window.__chatImageBlobs.delete(url); return revoke(url); };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', frame => frames.push({ page, payload: String(frame.payload) })));
  return page;
}
async function createRoom(page) {
  await page.goto(origin.origin);
  await page.getByRole('button', { name: /^创建聊天/ }).click();
  await page.waitForURL('**/c/**');
  await page.locator('.composer textarea:not([disabled])').waitFor();
  await page.waitForFunction(() => document.querySelector('.room-subtitle')?.textContent?.includes('端到端加密'));
}
async function send(page, text) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}
async function openArchive(page, mode) {
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByRole('menuitem', { name: mode === 'export' ? '导出记录' : '导入记录' }).click();
}
const chatFrames = page => frames.filter(frame => {
  if (frame.page !== page) return false;
  try { const value = JSON.parse(frame.payload); return value.type === 'peer_data' && value.data?.payload?.type === 'chat_message'; }
  catch { return false; }
});
async function imageDigest(page, index = 0) {
  return page.locator('.image-thumbnail img').nth(index).evaluate(async image => {
    await image.decode();
    const bytes = await window.__chatImageBlobs.get(image.src).arrayBuffer();
    return { size: bytes.byteLength, hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('') };
  });
}
try {
  const alice = await newPage(), bob = await newPage();
  phase = 'create real room and one-time invite';
  await createRoom(alice);
  await alice.getByRole('button', { name: '邀请', exact: true }).click();
  const invite = await alice.locator('#invite-link').inputValue();
  await bob.goto(invite);
  await bob.locator('.composer textarea:not([disabled])').waitFor();
  for (const page of [alice, bob]) await page.getByText('对方在线 · 端到端加密', { exact: true }).waitFor();
  phase = 'text ownership and encrypted live likes';
  await send(alice, 'Alice archive ownership sample');
  await bob.locator('.bubble-theirs').filter({ hasText: 'Alice archive ownership sample' }).waitFor();
  await send(bob, 'Bob archive ownership sample');
  await alice.locator('.bubble-theirs').filter({ hasText: 'Bob archive ownership sample' }).waitFor();
  await bob.locator('.bubble').filter({ hasText: 'Alice archive ownership sample' }).click();
  await alice.getByLabel('1 次点赞', { exact: true }).waitFor();
  phase = 'send actual multi-chunk noise PNG';
  const original = await alice.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 320;
    const context = canvas.getContext('2d'); const image = context.createImageData(320, 320);
    for (let offset = 0; offset < image.data.length; offset += 65536) crypto.getRandomValues(image.data.subarray(offset, offset + 65536));
    for (let offset = 3; offset < image.data.length; offset += 4) image.data[offset] = 255;
    context.putImageData(image, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const bytes = await blob.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    return { data: canvas.toDataURL('image/png').split(',')[1], size: bytes.byteLength, hash };
  });
  assert.ok(original.size > 100 * 1024, 'Use an image large enough to require multiple encrypted wire chunks');
  const beforeImage = chatFrames(alice).length;
  await alice.getByLabel('选择要发送的图片', { exact: true }).setInputFiles({ name: 'private-noise-image.png', mimeType: 'image/png', buffer: Buffer.from(original.data, 'base64') });
  await bob.locator('.image-thumbnail img').first().waitFor();
  assert.deepEqual(await imageDigest(bob), { size: original.size, hash: original.hash });
  assert.ok(chatFrames(alice).length - beforeImage > 1, 'Image must travel in multiple encrypted frames');
  phase = 'image preview zoom drag and close';
  await bob.getByRole('button', { name: '查看图片：private-noise-image.png', exact: true }).click();
  const preview = bob.getByRole('dialog', { name: '图片预览', exact: true });
  await preview.waitFor();
  await bob.getByRole('button', { name: '放大图片', exact: true }).click();
  assert.equal(await bob.locator('.image-preview-zoom').innerText(), '125%');
  const stage = await bob.locator('.image-preview-stage').boundingBox();
  await bob.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await bob.mouse.down(); await bob.mouse.move(stage.x + stage.width / 2 + 60, stage.y + stage.height / 2 + 45, { steps: 5 }); await bob.mouse.up();
  assert.match(await bob.locator('.image-preview-stage img').getAttribute('style'), /translate\(60px, 45px\)/);
  await bob.keyboard.press('Escape'); await preview.waitFor({ state: 'detached' });
  phase = 'receiver reload and real encrypted history resync';
  await bob.reload();
  await bob.locator('.image-thumbnail img').first().waitFor();
  await bob.getByText('对方在线 · 端到端加密', { exact: true }).waitFor();
  assert.deepEqual(await imageDigest(bob), { size: original.size, hash: original.hash });
  await send(bob, 'After reload still connected');
  await alice.locator('.bubble').filter({ hasText: 'After reload still connected' }).waitFor();
  phase = 'partial image expires and actual outbox retry resends fresh chunks';
  const beforePartial = chatFrames(alice).length;
  await alice.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let calls = 0;
    crypto.subtle.encrypt = async (...args) => {
      if (++calls === 3) { crypto.subtle.encrypt = encrypt; throw new Error('Synthetic third image part encryption failure'); }
      return encrypt(...args);
    };
  });
  await alice.getByLabel('选择要发送的图片', { exact: true }).setInputFiles({ name: 'private-retry-image.png', mimeType: 'image/png', buffer: Buffer.from(original.data, 'base64') });
  await alice.locator('.outbox-status').waitFor();
  assert.equal(chatFrames(alice).length - beforePartial, 2, 'Two encrypted parts must be sent before the third part fails');
  assert.equal(await bob.locator('.image-thumbnail').count(), 1, 'Partial transfer must not render a complete image');
  await bob.evaluate(() => {
    window.__imageRetryNow = Date.now;
    Date.now = () => window.__imageRetryNow() + 121000;
  });
  try {
    await alice.locator('.outbox-status').getByRole('button', { name: '重试发送', exact: true }).click();
    await bob.getByRole('button', { name: '查看图片：private-retry-image.png', exact: true }).waitFor();
    assert.equal(await bob.getByRole('button', { name: '查看图片：private-retry-image.png', exact: true }).count(), 1);
    assert.deepEqual(await imageDigest(bob, 1), { size: original.size, hash: original.hash });
    await alice.locator('.outbox-status').waitFor({ state: 'detached' });
  } finally { await bob.evaluate(() => { Date.now = window.__imageRetryNow; delete window.__imageRetryNow; }); }
  phase = 'export confirmation rejects mismatched passwords';
  let downloads = 0; alice.on('download', () => downloads++);
  await openArchive(alice, 'export');
  await alice.getByLabel('设置密码', { exact: true }).fill('test archive password');
  await alice.getByLabel('再次输入密码', { exact: true }).fill('wrong password');
  await alice.getByRole('button', { name: '加密并导出', exact: true }).click();
  await alice.getByText('两次输入的密码不一致', { exact: true }).waitFor();
  assert.equal(downloads, 0);
  await alice.getByLabel('再次输入密码', { exact: true }).fill('test archive password');
  const downloadPromise = alice.waitForEvent('download');
  await alice.getByRole('button', { name: '加密并导出', exact: true }).click();
  const download = await downloadPromise;
  const archivePath = join(temporary, 'history.achat'); await download.saveAs(archivePath);
  const encrypted = await readFile(archivePath, 'utf8');
  for (const secret of ['Alice archive ownership sample', 'private-noise-image.png', 'private-retry-image.png', original.data.slice(100, 200)]) assert.ok(!encrypted.includes(secret));
  phase = 'import into a different room and browser identity';
  const importer = await newPage(); await createRoom(importer);
  assert.notEqual(new URL(importer.url()).pathname, new URL(alice.url()).pathname);
  const beforeImport = chatFrames(importer).length;
  await openArchive(importer, 'import');
  await importer.getByLabel('记录文件', { exact: true }).setInputFiles(archivePath);
  await importer.getByLabel('输入密码', { exact: true }).fill('test archive password');
  await importer.getByRole('button', { name: '解密并导入', exact: true }).click();
  await importer.locator('.bubble-mine').filter({ hasText: 'Alice archive ownership sample' }).waitFor();
  await importer.locator('.bubble-theirs').filter({ hasText: 'Bob archive ownership sample' }).waitFor();
  await importer.getByLabel('1 次点赞', { exact: true }).waitFor();
  await importer.locator('.image-thumbnail img').first().waitFor();
  assert.deepEqual(await imageDigest(importer), { size: original.size, hash: original.hash });
  assert.deepEqual(await imageDigest(importer, 1), { size: original.size, hash: original.hash });
  await importer.locator('.bubble').filter({ hasText: 'Alice archive ownership sample' }).click();
  assert.equal(chatFrames(importer).length, beforeImport, 'Imported records do not send or replay interaction events');
  await importer.reload();
  await importer.locator('.image-thumbnail img').first().waitFor();
  assert.deepEqual(await imageDigest(importer), { size: original.size, hash: original.hash });
  assert.equal(chatFrames(importer).length, beforeImport, 'Reloaded imported history is not added to the outbox');
  assert.equal(await importer.locator('.outbox-status').count(), 0);
  // Joining a real peer must not cause local imported history to enter room sync.
  await importer.getByRole('button', { name: '邀请', exact: true }).click();
  const importRoomPeer = await newPage();
  await importRoomPeer.goto(await importer.locator('#invite-link').inputValue());
  await importRoomPeer.getByText('对方在线 · 端到端加密', { exact: true }).waitFor();
  await send(importRoomPeer, 'Fresh room peer connectivity check');
  await importer.locator('.bubble').filter({ hasText: 'Fresh room peer connectivity check' }).waitFor();
  assert.equal(chatFrames(importer).length, beforeImport, 'Imported messages remain excluded from live peer sync');
  assert.equal(await importRoomPeer.locator('.image-thumbnail').count(), 0);
  assert.equal(await importRoomPeer.locator('.bubble').filter({ hasText: 'Alice archive ownership sample' }).count(), 0);
  phase = 'wire confidentiality and browser errors';
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.ok(Buffer.byteLength(frame.payload) < 256 * 1024, 'Every relay frame remains below the server frame limit');
    for (const secret of ['Alice archive ownership sample', 'Bob archive ownership sample', 'private-noise-image.png', 'private-retry-image.png', original.data.slice(100, 200)]) assert.ok(!frame.payload.includes(secret), 'Wire payload must not disclose message or image plaintext');
  }
  assert.deepEqual(errors, []);
  console.log(`PASS real relay: text ownership, likes, ${original.size}-byte multi-chunk encrypted PNG, exact bytes/reload/resync, expired partial-transfer outbox retry, preview zoom/pan/close, confirmed encrypted export, different-identity import, no imported replay; ${frames.length} confidential bounded frames`);
} catch (error) {
  console.error(`FAIL ${phase}`);
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error(await page.locator('.room-subtitle,.room-error,.outbox-status').allTextContents());
  }
  if (errors.length) console.error('Browser errors:', errors);
  throw error;
} finally { await browser.close(); await rm(temporary, { recursive: true, force: true }); }
