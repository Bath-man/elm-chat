// Real image bubbles, windowing and scroll-following; no relay or image loader mocks.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: `
import React, {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MessageBubble} from './apps/web/src/MessageBubble';
import {VirtualMessageList} from './apps/web/src/VirtualMessageList';
import {useConversationScroll} from './apps/web/src/use-conversation-scroll';
import {encodeImage} from './apps/web/src/image-messages';
const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 1200;
canvas.getContext('2d').fillRect(0, 0, 900, 1200);
const image = encodeImage({name:'img-0123456789abcdef.png', mimeType:'image/png',
  data:canvas.toDataURL().split(',')[1], width:900, height:1200});
function Fixture() {
  const [messages, setMessages] = useState(Array.from({length:160}, (_, i) => ({
    id:'m'+i, plaintext:i === 145 ? image : '消息'+i, sentAt:1
  })));
  const navigationRef = useRef(null);
  const {chatLogRef, handleConversationScroll} = useConversationScroll(messages, true);
  window.fixture = {
    go:id => navigationRef.current.scrollToMessage(id),
    append:() => setMessages(current => [...current, {id:'m'+current.length, plaintext:'新消息', sentAt:1}]),
    clear:() => setMessages([])
  };
  return <main className="room-shell"><section className="chat-log" ref={chatLogRef} onScroll={handleConversationScroll}>
    <div className="chat-thread"><VirtualMessageList messages={messages} scrollRef={chatLogRef} navigationRef={navigationRef}
      renderMessage={message => <MessageBubble message={message} mine={false} likes={0} confirmed={false}
        onLike={async () => true} onEdit={() => {}}/>}/></div>
    </section><form className="composer"><textarea/></form></main>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic' });
const css = await readFile('apps/web/src/styles.css', 'utf8');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true,
  ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport:{width:mobile ? 390 : 1024, height:844},
      isMobile:mobile, hasTouch:mobile });
    try {
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>');
      await page.addStyleTag({content:css});
      // Track lifetimes without replacing the browser's Blob decoding behavior.
      await page.evaluate(() => {
        window.imageUrls = new Set();
        const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
        URL.createObjectURL = blob => { const url = create(blob); window.imageUrls.add(url); return url; };
        URL.revokeObjectURL = url => { window.imageUrls.delete(url); return revoke(url); };
      });
      await page.addScriptTag({content:bundled.outputFiles[0].text});
      const thumbnail = page.locator('.image-thumbnail img');
      await thumbnail.waitFor();
      await thumbnail.evaluate(image => image.decode());
      // Put the window in the long-chat geometry that originally oscillated.
      await page.evaluate(() => window.fixture.append());
      const samples = await page.evaluate(async () => {
        const frames = [];
        for (let i = 0; i < 90; i++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const image = document.querySelector('.image-thumbnail img');
          const list = document.querySelector('.virtual-message-list');
          frames.push({src:image?.getAttribute('src'), loaded:!!image?.naturalWidth,
            height:image?.getBoundingClientRect().height, start:list.dataset.rangeStart});
        }
        return frames;
      });
      const settled = samples.slice(-30);
      assert.ok(settled.every(frame => frame.loaded && frame.height > 0),
        'long-chat images must settle instead of alternating between empty and filename placeholders');
      assert.equal(new Set(settled.map(frame => frame.src)).size, 1,
        'a stationary viewport must retain one image URL');
      assert.equal(new Set(settled.map(frame => frame.start)).size, 1,
        'image loading must not perpetually oscillate the virtual range');
      assert.ok(await page.locator('[data-virtual-message]').count() < 60, 'long history stays windowed');
      // Move the range while the same image remains visible/overscanned.
      const original = await thumbnail.elementHandle();
      const src = await thumbnail.getAttribute('src');
      await page.evaluate(() => { const log = document.querySelector('.chat-log'); log.scrollTop -= 150; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await thumbnail.evaluate((image, previous) => image === previous, original),
        'overlapping windows retain the mounted image element');
      assert.equal(await thumbnail.getAttribute('src'), src, 'scrolling within the window does not revoke the image URL');
      await page.evaluate(() => window.fixture.go('m0'));
      await page.waitForFunction(() => !document.querySelector('.image-thumbnail'));
      await page.waitForFunction(() => window.imageUrls.size === 0);
      await page.evaluate(() => window.fixture.go('m145'));
      await thumbnail.waitFor(); await thumbnail.evaluate(image => image.decode());
      assert.ok(await thumbnail.evaluate(image => image.naturalWidth === 900 && image.naturalHeight === 1200),
        'returning to recycled history restores the original image');
      await page.evaluate(() => window.fixture.clear());
      await page.waitForFunction(() => !document.querySelector('[data-virtual-message]') && window.imageUrls.size === 0);
      assert.deepEqual(errors, [], 'no browser errors during image mount, recycle or cleanup');
      console.log('PASS ' + (mobile ? 'mobile' : 'desktop') + ': long-chat image settles, retains DOM/URL across windows and releases offscreen resources');
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
