'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'..','schedule-configured-test.html'),'utf8');
const match=html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(match,'inline page script exists');

function element(){
  return {
    value:'',textContent:'',type:'',required:false,disabled:false,hidden:false,
    children:[],handlers:{},
    addEventListener(name,handler){this.handlers[name]=handler;},
    appendChild(child){this.children.push(child);},
    replaceChildren(){this.children=[];}
  };
}
const elements={};
const get=id=>elements[id]||(elements[id]=element());
const context={
  document:{getElementById:get,createElement:element},
  URL,URLSearchParams,Error,console,
  window:{confirm:()=>false},
  crypto:{randomUUID:()=> 'test-id'},
  liff:{init:async()=>{},isLoggedIn:()=>true,getIDToken:()=> 'fake-token'},
  fetch:async()=>({ok:true,json:async()=>({ok:true})})
};
vm.createContext(context);
vm.runInContext(match[1],context);
vm.runInContext("render([{scheduleId:'night',employeeId:'TEST-A',workDate:'2099-01-15',startTime:'09:00',endTime:'17:00',revision:0}])",context);

const card=get('list').children[0];
const form=card.children[1];
const startLabel=form.children[0],endLabel=form.children[1];
const start=startLabel.children[0],end=endLabel.children[0];
assert.equal(endLabel.textContent,'終了 ');
end.value='05:00';end.handlers.input();
assert.equal(endLabel.textContent,'終了（翌日） ');
assert.deepEqual(Array.from(vm.runInContext("dirty",context)),['night']);
start.value='04:00';start.handlers.input();
assert.equal(endLabel.textContent,'終了 ');
start.value='22:00';start.handlers.input();
assert.equal(endLabel.textContent,'終了（翌日） ');
start.value='09:00';end.value='17:00';end.handlers.input();
assert.equal(endLabel.textContent,'終了 ');
assert.deepEqual(Array.from(vm.runInContext("dirty",context)),[]);
console.log('PASS: edit-form overnight label follows start/end inputs and clears when restored');
