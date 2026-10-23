// Isolated real React/browser regression; no backend, credentials, or extra runtime dependencies.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useConversationScroll } from './apps/web/src/use-conversation-scroll';

function RoomHooks() {
  const [state, setState] = useState({ ids: ['first'], ready: false, shown: false, paused: false });
  // Deliberately use a fresh array every render, including layout-effect renders.
  const scroll = useConversationScroll(state.ids.map(id => ({ id })), state.ready, state.paused);
  window.roomHooks = { update: patch => setState(current => ({ ...current, ...patch })), scroll };
  window.renderCount = (window.renderCount || 0) + 1;
  return <>
    <output id="status">{JSON.stringify({ away: scroll.awayFromLatest, count: scroll.newMessageCount })}</output>
    {state.shown && <section id="log" ref={scroll.chatLogRef} onScroll={scroll.handleConversationScroll}
      style={{ height: 100, overflow: 'auto', overflowAnchor: 'none' }}>
      {state.ids.map(id => <div key={id} style={{ height: 200 }}>{id}</div>)}
    </section>}
  </>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><RoomHooks /></React.StrictMode>);
`;

const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  // Development catches detailed maximum-depth warnings; production catches React #185.
  for (const mode of ['development', 'production']) {
    const bundled = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
      bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': JSON.stringify(mode) } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await page.locator('#status').waitFor();
    const settled = async () => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const first = await page.evaluate(() => window.renderCount);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => window.renderCount), first, `${mode}: render loop`);
      assert.deepEqual(errors, [], `${mode}: browser/React errors`);
    };
    const update = async patch => {
      await page.evaluate(patch => window.roomHooks.update(patch), patch);
      await settled();
    };
    const status = () => page.locator('#status').textContent().then(JSON.parse);
    await settled();
    assert.deepEqual(await status(), { away: false, count: 0 });
    await update({ shown: true, ready: true });
    await page.locator('#log').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await settled();
    assert.deepEqual(await status(), { away: true, count: 0 });
    await update({ ids: ['first', 'arrival'] });
    assert.deepEqual(await status(), { away: true, count: 1 });
    // Restoring a prepended history page must preserve the reader's position.
    await page.evaluate(() => window.roomHooks.scroll.preserveHistoryPosition());
    await update({ ids: ['older', 'first', 'arrival'] });
    assert.equal(await page.locator('#log').evaluate(element => element.scrollTop), 200);
    assert.deepEqual(await status(), { away: true, count: 1 });
    // Repeated equal snapshots must not accumulate unread messages or recurse.
    for (let attempt = 0; attempt < 20; attempt++) {
      await update({ ids: ['older', 'first', 'arrival'], ready: attempt % 2 === 0 });
      assert.deepEqual(await status(), { away: true, count: 1 });
    }
    await page.evaluate(() => window.roomHooks.scroll.jumpToLatest());
    await settled();
    assert.deepEqual(await status(), { away: false, count: 0 });
    // Access/reconnecting/hidden views can temporarily remove the chat log.
    await update({ shown: false, ready: false });
    await update({ shown: true, ready: true });
    await update({ paused: true, ids: ['older', 'first', 'arrival', 'paused-arrival'] });
    assert.deepEqual(await status(), { away: true, count: 1 });
    await page.evaluate(() => window.roomHooks.scroll.jumpToLatest());
    await settled();
    assert.deepEqual(await status(), { away: false, count: 0 });
    await page.close();
    console.log(`PASS room scroll hooks settle through mount, repeated snapshots, reconnect and paused arrivals (${mode})`);
  }
} finally {
  await browser.close();
}
