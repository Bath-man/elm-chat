// Real React/components/CSS regression. Touch emulation verifies DOM focus, not a physical OS keyboard.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as composer from './apps/web/src/composer';
import { MessageBubble } from './apps/web/src/MessageBubble';
function Fixture() {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState([]);
  const [revision, setRevision] = useState(0);
  const [sending, setSending] = useState(false);
  const [likes, setLikes] = useState(0);
  const [queued, setQueued] = useState(false);
  window.fixture = {
    add: message => setMessages(current => [...current, { sentAt: Date.now(), plaintext: 'Message', ...message }]),
    update: () => setRevision(value => value + 1),
    remove: id => setMessages(current => current.filter(message => message.id !== id)),
    delayed: false,
    queue: setQueued,
  };
  async function submit(event) {
    event.preventDefault();
    if (!draft || sending) return;
    setSending(true);
    if (window.delaySend) await new Promise(resolve => setTimeout(resolve, 150));
    const id = 'sent-' + (window.sendCount = (window.sendCount || 0) + 1);
    setMessages(current => [...current, { id,
      plaintext: draft, sentAt: Date.now(), mine: true, entrance: { until: Date.now() + 250 } }]);
    setDraft(''); setSending(false);
  }
  return <main className="room-shell">
    <button id="outside">Outside</button>
    <section id="log" className="chat-log" style={{height: 220, flex: 'none', overflowAnchor: 'none'}}>
      <div className="chat-thread">{messages.map(message => <MessageBubble key={message.id} message={message}
        mine={!!message.mine} likes={likes} confirmed={revision > 0} onLike={async () => { setLikes(count => count + 1); return true; }} onEdit={() => {}} />)}</div>
    </section>
    <form className="composer" onSubmit={submit}>
      {queued && <div className="outbox-status" role="status">1 条消息待发送 <button type="button">重试发送</button></div>}
      <textarea aria-label="Message" value={draft} onChange={event => setDraft(event.target.value)}
        onKeyDown={composer.handleComposerKeyDown} onBlur={() => window.blurCount = (window.blurCount || 0) + 1} />
      <button id="send" className="primary-button" type="submit" disabled={sending}
        onPointerDown={composer.preserveComposerFocus} onMouseDown={composer.preserveComposerFocus}>Send</button>
    </form>
  </main>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture /></React.StrictMode>);
`;
const bundled = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': JSON.stringify('development') } });
const css = await readFile(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  for (const mobile of [true, false]) {
    const context = await browser.newContext({ isMobile: mobile, hasTouch: mobile, viewport: { width: mobile ? 390 : 1024, height: 844 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    const textarea = page.getByRole('textbox', { name: 'Message' });
    await textarea.waitFor();
    const activate = locator => mobile ? locator.tap() : locator.click();
    await activate(textarea);
    for (let index = 0; index < 4; index++) {
      await textarea.fill('Message ' + index);
      await activate(page.locator('#send'));
      await page.waitForFunction(count => window.sendCount === count && document.querySelector('textarea').value === '', index + 1);
      assert.equal(await textarea.evaluate(element => document.activeElement === element), true, 'send must retain textarea focus');
      assert.equal(await page.evaluate(() => window.blurCount || 0), 0, 'sending must not blur the composer');
    }
    // Neither an outside tap nor deliberate keyboard dismissal may be undone after async completion.
    await activate(page.locator('#outside'));
    assert.equal(await textarea.evaluate(element => document.activeElement === element), false);
    await textarea.fill('Delayed');
    await page.evaluate(() => { window.delaySend = true; });
    await activate(page.locator('#send'));
    await textarea.evaluate(element => element.blur());
    await page.waitForFunction(() => window.sendCount === 5);
    assert.equal(await textarea.evaluate(element => document.activeElement === element), false, 'async completion must not refocus');
    await page.evaluate(() => { window.delaySend = false; });
    await textarea.fill('Enter send');
    await textarea.press('Enter');
    await page.waitForFunction(() => window.sendCount === 6);
    await textarea.fill('Accessible send');
    await page.locator('#send').focus();
    await page.locator('#send').press('Enter');
    await page.waitForFunction(() => window.sendCount === 7);
    assert.equal(await page.locator('#send').evaluate(element => document.activeElement === element), true, 'keyboard activation retains button focus');
    console.log('PASS ' + (mobile ? 'mobile touch' : 'desktop') + ': four consecutive sends retain focus; outside/blur stay dismissed; Enter and accessible button work');

    const layout = () => page.locator('#log, .composer textarea, #send').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    }));
    const unqueued = await layout();
    await page.evaluate(() => window.fixture.queue(true));
    await page.locator('.outbox-status').waitFor();
    assert.deepEqual(await layout(), unqueued, 'pending status must not change chat/composer layout');
    await page.evaluate(() => window.fixture.queue(false));
    await page.locator('.outbox-status').waitFor({ state: 'detached' });
    await textarea.fill('Unsent draft');
    await textarea.evaluate(element => { element.setSelectionRange(2, 5); window.blurCount = 0; });
    const likeTarget = page.locator('[data-message-id="sent-7"]');
    await activate(likeTarget);
    await likeTarget.locator('.like-count').waitFor();
    assert.equal(await textarea.evaluate(element => document.activeElement === element), true, 'liking must retain composer focus');
    assert.equal(await page.evaluate(() => window.blurCount || 0), 0, 'liking must not blur and refocus the composer');
    assert.equal(await textarea.inputValue(), 'Unsent draft');
    assert.deepEqual(await textarea.evaluate(element => [element.selectionStart, element.selectionEnd]), [2, 5]);
    await textarea.evaluate(element => element.blur());
    await activate(likeTarget);
    assert.equal(await textarea.evaluate(element => document.activeElement === element), false, 'liking must not reopen a dismissed keyboard');
    console.log('PASS pending status stays out of flow; liking preserves focus, draft and selection without reopening a dismissed keyboard');

    await page.waitForTimeout(260);
    await page.evaluate(() => {
      window.animationStarts = [];
      document.addEventListener('animationstart', event => {
        if (event.animationName === 'message-enter') window.animationStarts.push(event.target.dataset.messageId);
      });
      window.fixture.add({ id: 'mine', mine: true, entrance: { until: Date.now() + 250 } });
      window.fixture.add({ id: 'theirs', mine: false, entrance: { until: Date.now() + 250 } });
      window.fixture.add({ id: 'history' });
      window.fixture.add({ id: 'import', imported: true, entrance: { until: Date.now() + 250 } });
      window.fixture.add({ id: 'expired', entrance: { until: Date.now() - 1 } });
    });
    await page.waitForFunction(() => window.animationStarts.includes('mine') && window.animationStarts.includes('theirs'));
    for (const id of ['mine', 'theirs']) {
      const animation = await page.locator('[data-message-id="' + id + '"]').evaluate(element => {
        const style = getComputedStyle(element);
        return { name: style.animationName, duration: style.animationDuration, easing: style.animationTimingFunction };
      });
      assert.deepEqual(animation, { name: 'message-enter', duration: '0.22s', easing: 'ease-out' });
    }
    for (const id of ['history', 'import', 'expired']) {
      assert.equal(await page.locator('[data-message-id="' + id + '"]').evaluate(element => getComputedStyle(element).animationName), 'none', id + ' must not animate');
    }
    // CSS transforms must not change layout dimensions or the reader's scroll offset.
    await page.locator('#log').evaluate(element => { element.scrollTop = 40; });
    const before = await page.locator('#log').evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight,
      offsets: [...element.querySelectorAll('.bubble')].map(bubble => [bubble.offsetTop, bubble.offsetHeight]) }));
    await page.evaluate(() => window.fixture.update());
    await page.waitForTimeout(300);
    const after = await page.locator('#log').evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight,
      offsets: [...element.querySelectorAll('.bubble')].map(bubble => [bubble.offsetTop, bubble.offsetHeight]) }));
    assert.deepEqual(after, before, 'animation must not move scroll or layout');
    assert.deepEqual((await page.evaluate(() => window.animationStarts)).sort(), ['mine', 'theirs'], 'updates must not replay entry animation');
    await page.evaluate(() => window.fixture.remove('mine'));
    await page.locator('[data-message-id="mine"]').waitFor({ state: 'detached' });
    await page.evaluate(() => window.fixture.add({ id: 'mine', mine: true, entrance: { until: Date.now() - 1 } }));
    await page.waitForTimeout(40);
    assert.equal(await page.locator('[data-message-id="mine"]').evaluate(element => getComputedStyle(element).animationName), 'none', 'expired remount must not replay');
    await page.evaluate(() => {
      window.reusedEntrance = { until: Date.now() + 250 };
      window.fixture.add({ id: 'rapid-remount', entrance: window.reusedEntrance });
    });
    await page.waitForFunction(() => window.animationStarts.includes('rapid-remount'));
    await page.evaluate(() => window.fixture.remove('rapid-remount'));
    await page.locator('[data-message-id="rapid-remount"]').waitFor({ state: 'detached' });
    await page.evaluate(() => {
      if (window.reusedEntrance.until <= Date.now()) throw new Error('Rapid remount test missed the live entrance window');
      window.fixture.add({ id: 'rapid-remount', entrance: window.reusedEntrance });
    });
    await page.locator('[data-message-id="rapid-remount"]').waitFor();
    await page.waitForTimeout(70);
    assert.equal(await page.evaluate(() => window.animationStarts.filter(id => id === 'rapid-remount').length), 1,
      'a committed bubble remounted with the exact same live entrance token must not replay');
    await page.evaluate(() => window.fixture.add({ id: 'interrupted', entrance: { until: Date.now() + 250 } }));
    await page.waitForFunction(() => window.animationStarts.includes('interrupted'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('[data-message-id="interrupted"]').evaluate(element => getComputedStyle(element).animationName), 'none', 'enabling reduced motion cancels a live entrance');
    await page.evaluate(() => window.fixture.add({ id: 'reduced', entrance: { until: Date.now() + 250 } }));
    await page.locator('[data-message-id="reduced"]').waitFor();
    assert.equal(await page.locator('[data-message-id="reduced"]').evaluate(element => getComputedStyle(element).animationName), 'none', 'reduced motion disables entry');
    const beforeRestore = await page.evaluate(() => window.animationStarts.length);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.animationStarts.length), beforeRestore,
      'restoring normal motion must not replay older bubbles');
    assert.deepEqual(errors, [], 'no React/browser errors');
    console.log('PASS new outgoing/incoming animate independently; history/import/expired/reduced motion do not; no replay on updates/remount/motion preference changes or scroll/layout movement');
    await context.close();
  }
} finally {
  await browser.close();
}
