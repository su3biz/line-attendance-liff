"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'debug.html'), 'utf8');
const DEMO_HTML = fs.readFileSync(path.join(__dirname, '..', 'demo', 'debug.html'), 'utf8');
const SCRIPT = HTML.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

function element(tagName='div') {
  return {
    tagName, textContent:'', className:'', disabled:false, value:'', children:[], handlers:{}, options:[],
    addEventListener(name,fn){this.handlers[name]=fn;},
    appendChild(child){this.children.push(child);return child;},
    replaceChildren(...children){this.children=children;this.options=children;this.value=children[0]&&children[0].value||'';},
    add(option){this.children.push(option);this.options=this.children;},
  };
}

function makePage({authorized=true,fetchFailure=null,stateError=null,confirm=true,delaySwitch=false,timeoutMode='',initFailure=false,initHang=false,targets=[{employeeId:'T-02',displayName:'従業員02',role:'employee'}],html=HTML}={}) {
  const elements=new Map(),requests=[],confirmMessages=[],redirects=[];
  const get=(id)=>{if(!elements.has(id))elements.set(id,element(id==='targetUser'?'select':'div'));return elements.get(id);};
  let resolveSwitch;
  const context=vm.createContext({
    document:{getElementById:get,createElement:(tag)=>element(tag)},
    window:{location:{href:html===DEMO_HTML?'https://example.test/demo/debug.html':'https://example.test/debug.html',replace(url){redirects.push(url);}},confirm(message){confirmMessages.push(message);return confirm;}},
    URL,URLSearchParams,Option:class Option{constructor(text,value){this.text=text;this.textContent=text;this.value=value;}},
    setTimeout(fn,ms){
      const lastAction=requests.at(-1)&&requests.at(-1).action;
      if((timeoutMode==='init'&&ms===15000)||(timeoutMode==='state'&&lastAction==='debugUserSwitchState'&&ms===20000)||(timeoutMode==='switch'&&lastAction==='debugUserSwitch'&&ms===20000)){queueMicrotask(fn);return 'forced-timeout';}
      if(ms===350){fn();return 'redirect-timer';}
      return global.setTimeout(fn,ms);
    },
    clearTimeout(id){if(typeof id==='number'||(id&&typeof id==='object'))global.clearTimeout(id);},
    AbortController,
    liff:{async init(){if(initFailure)throw Error('synthetic init failure');if(initHang)return new Promise(()=>{});},isLoggedIn(){return true;},getIDToken(){return 'synthetic-id-token';},login(){throw Error('unexpected login');}},
    fetch:async(_url,options)=>{
      const fields=Object.fromEntries(new URLSearchParams(options.body).entries());requests.push(fields);
      if(fetchFailure==='transport'&&fields.action==='debugUserSwitch')throw Error('synthetic network failure');
      if((timeoutMode==='state'&&fields.action==='debugUserSwitchState')||(timeoutMode==='switch'&&fields.action==='debugUserSwitch'))return new Promise(()=>{});
      if(fetchFailure&&fields.action==='debugUserSwitch')return {ok:true,json:async()=>({ok:false,code:fetchFailure})};
      if(fields.action==='debugUserSwitchState')return {ok:true,json:async()=>stateError?({ok:false,code:stateError}):authorized?({ok:true,currentUser:{employeeId:'T-01',displayName:'従業員01',role:'employee'},targets}):({ok:false,code:'DEBUG_FORBIDDEN'})};
      if(fields.action==='debugUserSwitch'){
        if(delaySwitch)return new Promise(resolve=>{resolveSwitch=()=>resolve({ok:true,json:async()=>({ok:true,code:'SWITCHED',correlationId:'abcdef123456'})});});
        return {ok:true,json:async()=>({ok:true,code:'SWITCHED',correlationId:'abcdef123456'})};
      }
      throw Error('unexpected API action');
    },
  });
  const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script,context);
  return {context,get,requests,confirmMessages,redirects,get resolveSwitch(){return resolveSwitch;}};
}

async function settle(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));}

test('debug switch page displays only the server-authorized user list and starts unselected', async()=>{
  const page=makePage();await settle();
  assert.equal(page.get('currentUser').textContent,'従業員01（従業員）');
  assert.deepEqual(page.get('targetUser').options.map(option=>option.value),['','T-02']);
  assert.equal(page.get('targetUser').value,'');
  assert.equal(page.get('changeButton').disabled,true);
});
test('unauthorized user receives no current assignment or target details', async()=>{
  const page=makePage({authorized:false});await settle();
  assert.equal(page.get('targetUser').disabled,true);
  assert.equal(page.get('targetUser').options.length,1);
  assert.equal(page.get('currentUser').textContent,'ユーザー情報を確認できません');
  assert.doesNotMatch(page.get('currentUser').textContent,/従業員01|T-01/);
  assert.match(page.get('message').textContent,/許可されていません/);
  assert.match(page.get('message').textContent,/DEBUG_FORBIDDEN/);
});

test('initialization errors and deadlines replace the loading label with a fixed code and explanation',async()=>{
  for(const options of [{initFailure:true},{initHang:true,timeoutMode:'init'},{timeoutMode:'state',fetchFailure:null}]){
    const page=makePage(options);await settle();
    assert.notEqual(page.get('currentUser').textContent,'確認中…');
    assert.match(page.get('currentUser').textContent,/確認できません/);
    assert.match(page.get('message').textContent,/LIFF_INIT_TIMEOUT|INITIALIZATION_FAILED|TRANSPORT_TIMEOUT/);
  }
});

test('GAS initialization errors display their fixed code and user-facing explanation',async()=>{
  const page=makePage({stateError:'DEBUG_UNAVAILABLE'});await settle();
  assert.notEqual(page.get('currentUser').textContent,'確認中…');
  assert.match(page.get('currentUser').textContent,/確認できません/);
  assert.match(page.get('message').textContent,/DEBUG_UNAVAILABLE/);
  assert.match(page.get('message').textContent,/現在利用できません/);
  assert.equal(page.get('targetUser').options.length,1);
});

test('no allowed unassigned target leaves the selector and change action unavailable', async()=>{
  const page=makePage({targets:[]});await settle();
  assert.equal(page.get('targetUser').disabled,true);
  assert.equal(page.get('changeButton').disabled,true);
  assert.match(page.get('message').textContent,/いません/);
});

test('selecting a target enables confirmation, sends only the target selector, and redirects after success', async()=>{
  const page=makePage();await settle();
  page.get('targetUser').value='T-02';page.get('targetUser').handlers.change();
  assert.equal(page.get('changeButton').disabled,false);
  await page.get('changeButton').handlers.click();await settle();
  assert.equal(page.confirmMessages.length,1);
  assert.deepEqual(Object.keys(page.requests[1]).sort(),['action','employeeId','id_token']);
  assert.equal(page.requests[1].employeeId,'T-02');
  assert.equal(page.requests[1].id_token,'synthetic-id-token');
  assert.equal(page.redirects.length,1);
  assert.match(page.redirects[0],/index\.html$/);
});

test('unconfirmed switch does not send, and an unknown result is surfaced without retry', async()=>{
  const cancelled=makePage({confirm:false});await settle();
  cancelled.get('targetUser').value='T-02';cancelled.get('targetUser').handlers.change();
  await cancelled.get('changeButton').handlers.click();
  assert.equal(cancelled.requests.filter(request=>request.action==='debugUserSwitch').length,0);
  const failed=makePage({fetchFailure:'DEBUG_OUTCOME_UNKNOWN'});await settle();
  failed.get('targetUser').value='T-02';failed.get('targetUser').handlers.change();
  await failed.get('changeButton').handlers.click();
  assert.equal(failed.requests.filter(request=>request.action==='debugUserSwitch').length,1);
  assert.match(failed.get('message').textContent,/再操作せず/);
  assert.equal(failed.redirects.length,0);
  const transport=makePage({fetchFailure:'transport'});await settle();
  transport.get('targetUser').value='T-02';transport.get('targetUser').handlers.change();
  await transport.get('changeButton').handlers.click();
  assert.equal(transport.requests.filter(request=>request.action==='debugUserSwitch').length,1);
  assert.match(transport.get('message').textContent,/再操作せず/);
  assert.equal(transport.redirects.length,0);
  const timedOut=makePage({timeoutMode:'switch'});await settle();
  timedOut.get('targetUser').value='T-02';timedOut.get('targetUser').handlers.change();
  await timedOut.get('changeButton').handlers.click();await settle();
  assert.equal(timedOut.requests.filter(request=>request.action==='debugUserSwitch').length,1);
  assert.match(timedOut.get('message').textContent,/DEBUG_OUTCOME_UNKNOWN/);
  assert.equal(timedOut.redirects.length,0);
});

test('in-flight switch disables repeated submissions', async()=>{
  const page=makePage({delaySwitch:true});await settle();
  page.get('targetUser').value='T-02';page.get('targetUser').handlers.change();
  const pending=page.get('changeButton').handlers.click();
  await settle();
  assert.equal(page.get('changeButton').disabled,true);
  assert.equal(page.requests.filter(request=>request.action==='debugUserSwitch').length,1);
  page.resolveSwitch();await pending;await settle();
  assert.equal(page.redirects.length,1);
});

test('customer demo switch uses only the customer demo connection and returns to demo index',async()=>{
  assert.match(DEMO_HTML,/const LIFF_ID='2012227652-aPqnxqOi';/);
  assert.match(DEMO_HTML,/const GAS_URL='https:\/\/script\.google\.com\/macros\/s\/AKfycbzdMHPEqF1b2fHhH2y-li0tO4KVH9FWwQtbBH2ozpJpHtEiSDRdnNvt2K2J7ABLRUmF4A\/exec';/);
  assert.doesNotMatch(DEMO_HTML,/AKfycbx4hCvYIKhSJlnDpGaKAUTk8iiEkvWaxfp957GDirqv3dam6rhloMM9FDAmP4VQtMPS/);
  const page=makePage({html:DEMO_HTML});await settle();
  assert.equal(page.requests[0].action,'debugUserSwitchState');
  page.get('targetUser').value='T-02';page.get('targetUser').handlers.change();
  await page.get('changeButton').handlers.click();await settle();
  assert.equal(page.requests[1].action,'debugUserSwitch');
  assert.equal(page.redirects.length,1);
  assert.match(page.redirects[0],/demo\/index\.html$/);
});


