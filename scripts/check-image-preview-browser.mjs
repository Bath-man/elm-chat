import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const bundled = await build({ stdin: { contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ImagePreview} from './apps/web/src/ImagePreview';
import {readChatImage} from './apps/web/src/image-messages';
window.readChatImage=readChatImage;
const image = {name:'tiny.png',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',width:1,height:1};
function Fixture(){const [open,setOpen]=useState(false);return <><button id="open" onClick={()=>setOpen(true)}>Open</button>{open&&<ImagePreview image={image} onClose={()=>setOpen(false)}/>}</>}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
const css = await readFile('apps/web/src/styles.css','utf8');
const browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try {
  for(const touch of [false,true]){
    const context = await browser.newContext({viewport:{width:390,height:844},hasTouch:touch,isMobile:touch});
    const page = await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>');
    await page.addStyleTag({content:css});await page.addScriptTag({content:bundled.outputFiles[0].text});
    await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=2;canvas.height=3;
      for(const mime of ['image/png','image/jpeg','image/webp']){
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,mime));
        const result=await window.readChatImage(new File([blob],'sample',{type:mime}));
        if(result.width!==2||result.height!==3||result.mimeType!==mime)throw new Error('Raster read mismatch '+mime);
      }
      const jpeg=new Uint8Array(await(await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg'))).arrayBuffer());
      const exif=new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
      const bytes=new Uint8Array(jpeg.length+exif.length);bytes.set(jpeg.subarray(0,2));bytes.set(exif,2);bytes.set(jpeg.subarray(2),2+exif.length);
      const image=await window.readChatImage(new File([bytes],'rotated-phone.jpg',{type:'image/jpeg'}));
      if(image.width!==2||image.height!==3)throw new Error('EXIF JPEG must preserve raw intrinsic dimensions');
    });
    await page.click('#open');await page.getByRole('dialog',{name:'图片预览'}).waitFor();
    await page.getByRole('button',{name:'放大图片',exact:true}).click();
    assert.equal(await page.locator('.image-preview-zoom').textContent(),'125%');
    await page.locator('.image-preview-stage').hover(); await page.mouse.wheel(0,-200);
    await page.waitForTimeout(50);assert.notEqual(await page.locator('.image-preview-zoom').textContent(),'125%');
    const stage=await page.locator('.image-preview-stage').boundingBox();
    await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height/2);await page.mouse.down();await page.mouse.move(stage.x+stage.width/2+45,stage.y+stage.height/2+30);await page.mouse.up();
    assert.match(await page.locator('.image-preview-stage img').getAttribute('style'),/translate\(45px, 30px\)/);
    await page.getByRole('button',{name:'复位图片'}).click();assert.equal(await page.locator('.image-preview-zoom').textContent(),'100%');
    if(touch){
      await page.locator('.image-preview-stage').evaluate(el=>{
        const send=(type,id,x,y)=>el.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'touch',pointerId:id,clientX:x,clientY:y}));
        send('pointerdown',11,100,200);send('pointerdown',12,200,200);send('pointermove',12,300,200);send('pointerup',11,100,200);send('pointerup',12,300,200);
      });
      await page.waitForFunction(()=>document.querySelector('.image-preview-zoom')?.textContent==='200%');
      assert.equal(await page.locator('.image-preview-zoom').textContent(),'200%');
    }
    await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('#open').evaluate(el=>el===document.activeElement),true);
    await page.click('#open');await page.getByRole('button',{name:'关闭图片预览'}).click();assert.equal(await page.getByRole('dialog').count(),0);
    assert.deepEqual(errors,[]);await context.close();
  }
  console.log('Image preview browser checks passed (desktop + touch).');
}finally{await browser.close();}
