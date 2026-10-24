// Real compact rows and windowing: an overlapping message keeps its live heart
// when scrolling changes the virtual window, without increasing the row height.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `
import React, {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MessageBubble} from './apps/web/src/MessageBubble';
import {VirtualMessageList} from './apps/web/src/VirtualMessageList';
const messages=Array.from({length:160},(_,index)=>({id:'message-'+index,plaintext:'消息 '+index,sentAt:1700000000000}));
function Fixture(){
 const scrollRef=useRef(null), navigationRef=useRef(null), [likes,setLikes]=useState({});
 window.navigateToMessage=id=>navigationRef.current.scrollToMessage(id);
 return <main className="room-shell"><section className="chat-log" ref={scrollRef}>
 <VirtualMessageList messages={messages} scrollRef={scrollRef} navigationRef={navigationRef}
 renderMessage={message=><MessageBubble message={message} mine={true} likes={likes[message.id]??0} confirmed={false}
 onLike={async()=>{setLikes(current=>({...current,[message.id]:(current[message.id]??0)+1}));return true;}} onEdit={()=>{}}/>}/>
 </section></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const bundled = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic' });
const css = await readFile(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ isMobile: mobile, hasTouch: mobile,
      viewport: { width: mobile ? 390 : 1024, height: 844 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundled.outputFiles[0].text });
      await page.waitForFunction(() => !!window.navigateToMessage);
      await page.evaluate(() => window.navigateToMessage('message-80'));
      const target = page.locator('[data-message-id="message-80"]');
      await target.waitFor();
      // Wait for initial height measurements to finish before triggering the like.
      await page.waitForFunction(() => {
        const rect=document.querySelector('[data-message-id="message-80"]')?.getBoundingClientRect();
        return rect && rect.top > 100 && rect.bottom < innerHeight - 100;
      });
      const heightBefore = await target.evaluate(element => element.parentElement.getBoundingClientRect().height);
      if (mobile) await target.tap(); else await target.click();
      const heart = target.locator('.floating-heart');
      await heart.waitFor({ state: 'attached' });
      const handle = await heart.elementHandle();
      await handle.evaluate(element => {
        const animation = element.getAnimations()[0];
        animation.pause();
        animation.currentTime = Number(animation.effect.getTiming().duration) * .35;
      });
      const before = await handle.evaluate(element => ({ top: element.getBoundingClientRect().top,
        opacity: Number(getComputedStyle(element).opacity), animation: getComputedStyle(element).animationName }));
      assert.equal(before.animation, 'heart-rise', 'a like starts the floating-heart animation');
      assert.ok(before.opacity > .5, 'the animated heart is visible before the window changes');
      const rangeBefore = await page.locator('.virtual-message-list').getAttribute('data-range-start');
      await page.locator('.chat-log').evaluate(log => { log.scrollTop += 120; });
      await page.waitForFunction(previous => document.querySelector('.virtual-message-list').dataset.rangeStart !== previous, rangeBefore);
      assert.equal(await handle.evaluate(element => element.isConnected), true,
        'scrolling an overlapping message must retain its active floating heart');
      assert.equal(await target.locator('.floating-heart').count(), 1, 'the like keeps one live heart after window movement');
      const heightAfter = await target.evaluate(element => element.parentElement.getBoundingClientRect().height);
      assert.ok(heightAfter <= 44 && Math.abs(heightAfter - heightBefore) < 1, 'heart animation preserves compact single-line row height');
      const resumed = await handle.evaluate(element => {
        const animation=element.getAnimations()[0];
        animation.currentTime=Number(animation.effect.getTiming().duration)*.75;
        const style=getComputedStyle(element);
        const matrix=new DOMMatrixReadOnly(style.transform);
        animation.play();
        return {opacity:Number(style.opacity), rise:matrix.m42};
      });
      assert.ok(resumed.opacity > 0 && resumed.rise < -20, 'heart remains visible and rises above its compact bubble');
      await page.waitForFunction(() => document.querySelectorAll('.floating-heart').length === 0);
      assert.equal(await target.locator('..').locator('.like-count').textContent(), '1', 'animation cleanup preserves the like count beside the bubble');
      assert.deepEqual(errors, [], 'no browser errors during the heart animation');
      console.log(`PASS ${mobile ? 'mobile touch' : 'desktop'}: visible heart survives virtual window movement, rises, cleans up, and keeps compact rows`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
