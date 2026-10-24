// Real components/CSS geometry regression. The menu JSX comes directly from App;
// its network/action handlers are inert here, so this does not validate relay behavior.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const menuStart = source.indexOf('<div id="chat-more-menu"');
const menuEnd = source.indexOf('\n        </div>}', menuStart);
assert.ok(menuStart >= 0 && menuEnd > menuStart, 'App chat tools menu JSX must be available');
const menu = source.slice(menuStart, menuEnd + '\n        </div>'.length);
const fixture = `
import React, {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MessageBubble} from './apps/web/src/MessageBubble';
import {VirtualMessageList} from './apps/web/src/VirtualMessageList';
import {encodeImage} from './apps/web/src/image-messages';
const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;
canvas.getContext('2d').fillRect(0,0,120,80);
const image=encodeImage({name:'sample.png',mimeType:'image/png',data:canvas.toDataURL('image/png').split(',')[1],width:120,height:80});
const messages = [
 {id:'short-theirs',plaintext:'你好'}, {id:'short-mine',plaintext:'收到',mine:true,delivery:'pending'},
 {id:'long-theirs',plaintext:'这是一条较长的消息。'.repeat(24)},
 {id:'long-mine',plaintext:'LongUnbrokenWord'.repeat(24),mine:true,imported:true},
 {id:'image-theirs',plaintext:image}, {id:'image-mine',plaintext:image,mine:true}
].map(m=>({...m,sentAt:1700000000000}));
function Fixture(){
 const scrollRef=useRef(null),navigationRef=useRef(null);
 const [showMore,setShowMore]=useState(false);
 const imageBusy=false,keyReady=true,room={status:'open'},imageInputRef=useRef(null);
 const openArchive=()=>{},openInteraction=()=>{},sendInteraction=()=>{},generateMessageId=()=> 'fixture';
 return <main className="room-shell">
 <section className="chat-log" ref={scrollRef}><VirtualMessageList messages={messages} scrollRef={scrollRef} navigationRef={navigationRef}
 renderMessage={message=><MessageBubble message={message} mine={!!message.mine} likes={message.id==='short-theirs'?2:0} confirmed={false} onLike={async()=>true} onEdit={()=>{}}/>}/></section>
 <form className="composer" onSubmit={e=>e.preventDefault()}><div className="composer-tools">
 <button type="button" aria-label="更多功能" onClick={()=>setShowMore(!showMore)}>+</button>
 {showMore && ${menu}}
 </div><textarea aria-label="消息"/><button>发送</button></form></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const bundled = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic' });
const css = await readFile(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  for (const width of [320, 390, 640]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, colorScheme);
    await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await page.locator('[data-message-id="image-mine"]').waitFor();
    await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
    const geometry = await page.locator('.message-row').evaluateAll(rows => rows.map(row => {
      const bubble = row.querySelector('.bubble'), meta = row.querySelector('.message-meta');
      const b = bubble.getBoundingClientRect(), m = meta.getBoundingClientRect(), r = row.getBoundingClientRect();
      const style = getComputedStyle(bubble);
      return { id: bubble.dataset.messageId, mine: row.classList.contains('message-row-mine'),
        bubble: { left:b.left,right:b.right,top:b.top,bottom:b.bottom,height:b.height },
        meta: { left:m.left,right:m.right,top:m.top,bottom:m.bottom,height:m.height },
        row: { left:r.left,right:r.right,height:r.height },
        metaOutside: meta.parentElement === row && !bubble.contains(meta),
        metaWhiteSpace:getComputedStyle(meta).whiteSpace,
        image:!!bubble.querySelector('.image-thumbnail'),background:style.backgroundColor,
        padding:style.padding,borderWidth:style.borderWidth };
    }));
    assert.equal(geometry.length, 6, `${width}/${colorScheme}: every fixture message rendered`);
    for (const item of geometry) {
      const label = `${width}/${colorScheme}/${item.id}`;
      assert.equal(item.metaOutside, true, `${label}: metadata is a bubble sibling`);
      assert.equal(item.metaWhiteSpace, 'nowrap', `${label}: metadata stays on one line`);
      assert.ok(item.meta.top < item.bubble.bottom && item.meta.bottom > item.bubble.top,
        `${label}: metadata vertically overlaps bubble instead of occupying its own row`);
      assert.ok(item.mine ? item.meta.right <= item.bubble.left + 1 : item.meta.left >= item.bubble.right - 1,
        `${label}: metadata sits toward chat center beside its bubble`);
      assert.ok(item.row.left >= -1 && item.row.right <= width + 1, `${label}: row stays in viewport`);
      assert.ok(item.bubble.left >= -1 && item.bubble.right <= width + 1 && item.meta.left >= -1 && item.meta.right <= width + 1,
        `${label}: long content does not push metadata outside viewport`);
      if (item.id.startsWith('short')) assert.ok(item.row.height <= 44, `${label}: short message has compact single-line height`);
      if (item.image) {
        assert.equal(item.background, 'rgba(0, 0, 0, 0)', `${label}: image has no bubble fill`);
        assert.equal(item.padding, '0px', `${label}: image has no bubble padding`);
        assert.equal(item.borderWidth, '0px', `${label}: image has no bubble border`);
      }
    }
    const pending = page.locator('[data-message-id="short-mine"]').locator('..').locator('.message-meta');
    assert.match(await pending.innerText(), /待发送/);
    const imported = page.locator('[data-message-id="long-mine"]').locator('..').locator('.message-meta');
    assert.match(await imported.innerText(), /导入记录/);
    const gap = geometry[1].bubble.top - geometry[0].bubble.bottom;
    assert.ok(gap >= 0 && gap <= 10, `${width}/${colorScheme}: adjacent short rows use a compact gap (${gap})`);
    await page.getByRole('button', { name: '更多功能' }).click();
    const groups = page.getByRole('menu', { name: '聊天工具' }).getByRole('group');
    assert.deepEqual(await groups.evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), ['消息互动', '更多工具', '记录备份']);
    const labels = await groups.evaluateAll(items => items.map(item => [...item.querySelectorAll('[role="menuitem"]')].map(button => button.textContent.trim())));
    assert.equal(labels[0].length, 2); assert.ok(labels[0].some(text => text.includes('摇骰子'))); assert.ok(labels[0].some(text => text.includes('发送图片')));
    assert.equal(labels[1].length, 4);
    assert.match(labels[2][0], /导入记录/); assert.match(labels[2][1], /导出记录/);
    const menuGeometry = await groups.evaluateAll(items => items.map(item => {
      const rect=item.getBoundingClientRect(), buttons=[...item.querySelectorAll('button')].map(button=>button.getBoundingClientRect());
      const style=getComputedStyle(item);
      return {top:rect.top,bottom:rect.bottom,border:parseFloat(style.borderTopWidth),borderStyle:style.borderTopStyle,
        buttons:buttons.map(rect=>({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}))};
    }));
    for (let index = 1; index < menuGeometry.length; index++) {
      assert.ok(menuGeometry[index].top >= menuGeometry[index-1].bottom, 'Menu groups are vertically separated');
      assert.ok(menuGeometry[index].border > 0 && menuGeometry[index].borderStyle !== 'none', 'Groups have a subtle separating rule');
    }
    const backup = menuGeometry[2].buttons;
    assert.ok(Math.abs(backup[0].top-backup[1].top)<1 && backup[0].right<=backup[1].left, 'Import is left of export in the bottom row');
    assert.deepEqual(errors, [], `${width}/${colorScheme}: no browser runtime errors`);
    await context.close();
  }
  console.log('Compact chat browser checks passed (320/390/640 px, light/dark, grouped menu, sibling metadata, borderless images).');
} finally { await browser.close(); }
