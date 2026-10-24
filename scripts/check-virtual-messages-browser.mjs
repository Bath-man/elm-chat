// Isolated real-browser geometry check; no app/network behavior is mocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';

let browser;
let server;
try {
  const result = await build({
    stdin: { contents: `
      import React, {useRef,useState,useLayoutEffect} from 'react';
      import {createRoot} from 'react-dom/client';
      import {VirtualMessageList} from './apps/web/src/VirtualMessageList';
      function Message({message}) {
        const [count,setCount]=useState(0);
        return <button data-id={message.id} onClick={()=>setCount(count+1)} style={{height:message.height,flexShrink:0}}>{message.id}:{count}</button>;
      }
      function Fixture() {
        const [messages,setMessages]=useState(Array.from({length:2000},(_,i)=>({id:'m'+i,height:45+(i%7)*23})));
        const log=useRef(null), nav=useRef(null), anchor=useRef(null);
        useLayoutEffect(()=>{if(anchor.current){log.current.scrollTop=anchor.current.top+log.current.scrollHeight-anchor.current.height;anchor.current=null;}},[messages]);
        window.fixture={
          go:id=>nav.current.scrollToMessage(id),
          append:()=>{setMessages(m=>[...m,{id:'appended',height:170}]);},
          prepend:()=>{anchor.current={top:log.current.scrollTop,height:log.current.scrollHeight};setMessages(m=>[{id:'prepended',height:120},...m]);},
          resize:id=>setMessages(m=>m.map(x=>x.id===id?{...x,height:x.height+200}:x))
        };
        return <div ref={log} className="chat-log" style={{height:600,overflow:'auto',overflowAnchor:'none'}}>
          <VirtualMessageList messages={messages} scrollRef={log} navigationRef={nav} renderMessage={message=><Message message={message}/>}/>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic'
  });
  const script = result.outputFiles[0].text;
  server = createServer((request,response)=>{ response.setHeader('Content-Type','text/html'); response.end(`<div id="root"></div><script>${script}</script>`); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r)))));
  await page.waitForSelector('[data-id="m0"]');
  await settle();
  const count=()=>page.locator('[data-virtual-message]').count();
  assert.ok(await count()<50,'initial window is bounded');
  await page.evaluate(()=>{window.originalSlot=document.querySelector('[data-virtual-message]');});
  await page.locator('[data-id="m0"]').click();
  assert.equal(await page.locator('[data-id="m0"]').textContent(),'m0:1');
  await page.evaluate(()=>window.fixture.go('m1500'));
  await settle();
  await page.waitForSelector('[data-id="m1500"]');
  assert.ok(await count()<50,'far window is bounded');
  assert.ok(await page.evaluate(()=>document.querySelector('[data-virtual-message]')===window.originalSlot),'slot DOM reused');
  assert.ok(await page.locator('[data-id="m1500"]').textContent()==='m1500:0','message state reset');
  const assertVisible=async id=>assert.ok(await page.locator(`[data-id="${id}"]`).evaluate(el=>{const r=el.getBoundingClientRect(),l=document.querySelector('.chat-log').getBoundingClientRect();return r.top>=l.top&&r.bottom<=l.bottom;}),'target fully visible');
  await assertVisible('m1500');
  // Repeated normal scrolls must unmount rows behind and mount the current region.
  for(const fraction of [.8,.2,.95,.05,.6]) {
    await page.evaluate(f=>{const log=document.querySelector('.chat-log');log.scrollTop=(log.scrollHeight-log.clientHeight)*f;},fraction);
    await settle();
    assert.ok(await count()<50,'scrolled window is bounded');
    assert.ok(await page.locator('[data-virtual-message]').evaluateAll(rows=>rows.some(el=>{const r=el.getBoundingClientRect(),l=document.querySelector('.chat-log').getBoundingClientRect();return r.top<l.bottom&&r.bottom>l.top;})),'scrolled viewport is populated');
  }
  await page.evaluate(()=>window.fixture.go('m40'));
  await settle();
  await assertVisible('m40');
  const before=await page.locator('[data-id="m40"]').evaluate(el=>el.getBoundingClientRect().top);
  await page.evaluate(()=>window.fixture.prepend());
  await settle();
  assert.ok(Math.abs(await page.locator('[data-id="m40"]').evaluate(el=>el.getBoundingClientRect().top)-before)<2,'prepend preserves anchor');
  const beforeResize=await page.locator('[data-id="m40"]').evaluate(el=>el.getBoundingClientRect().top);
  await page.evaluate(()=>{
    const row=document.querySelector('[data-virtual-message] button');
    row.style.height=(row.getBoundingClientRect().height+180)+'px';
  });
  await settle();
  assert.ok(Math.abs(await page.locator('[data-id="m40"]').evaluate(el=>el.getBoundingClientRect().top)-beforeResize)<2,'intrinsic resize above viewport preserves anchor');
  await page.evaluate(()=>window.fixture.resize('m40'));
  await settle();
  assert.ok(await page.locator('[data-id="m40"]').evaluate(el=>el.offsetHeight)>200,'dynamic resize measured');
  await page.evaluate(()=>window.fixture.go('m1999'));
  await settle();
  await page.evaluate(()=>{const log=document.querySelector('.chat-log');log.scrollTop=log.scrollHeight;});
  await settle();
  await page.evaluate(()=>window.fixture.append());
  await settle();
  // The application scroll hook owns following on message additions.
  await page.evaluate(()=>{const log=document.querySelector('.chat-log');log.scrollTop=log.scrollHeight;});
  await settle();
  await assertVisible('appended');
  await page.evaluate(()=>window.fixture.go('m0'));
  await settle();
  await assertVisible('m0');
  assert.equal(await page.locator('[data-id="m0"]').textContent(),'m0:0','recycled message does not retain prior UI state');
  assert.deepEqual(errors,[]);
  console.log('PASS virtual list: 2000 variable-height rows, bounded DOM, reusable slots, reverse scrolling, find, prepend anchoring, resize, append');
} finally {
  await browser?.close();
  await new Promise(resolve=>server?server.close(resolve):resolve());
}
