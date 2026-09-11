
import * as fs from 'node:fs';
import * as path from 'node:path';
const dir=process.env.CLAUDE_CONFIG_DIR, scenario=process.env.SEED_CASE;
const sid='aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', cwd=process.cwd();
const file=path.join(dir,'projects','fixture',sid+'.jsonl');
const events=path.join(dir,'events.jsonl'), statusFile=path.join(dir,'sessions',process.pid+'.json');
fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(path.dirname(statusFile),{recursive:true});
const status={pid:process.pid,sessionId:sid,cwd,startedAt:Date.now(),kind:'interactive',entrypoint:'cli',version:'fixture',
 procStart:process.platform==='linux'?fs.readFileSync('/proc/self/stat','utf8').split(') ').pop().split(' ')[19]:'opaque-test-start',
 pidDomain:process.platform==='linux'?'linux:'+fs.readFileSync('/etc/machine-id','utf8').trim()+':'+fs.readlinkSync('/proc/self/ns/pid'):'test-domain'};
if(scenario==='wrong-pid')status.pid++;
if(scenario==='wrong-start')status.procStart+='0';
if(scenario==='wrong-domain')status.pidDomain+='-different';
if(scenario==='startup-waiting')status.waitingFor='permission prompt';
fs.writeFileSync(statusFile,JSON.stringify(status));
const event=(kind,value)=>fs.appendFileSync(events,JSON.stringify({kind,value,at:Date.now()})+'\n');
const row=(type,content,stop)=>JSON.stringify({type,sessionId:sid,cwd,message:{role:type,content,stop_reason:stop}})+'\n';
const text=s=>[{type:'text',text:s}];
const append=(type,content,stop)=>fs.appendFileSync(file,row(type,content,stop));
const frame=s=>process.stdout.write('\x1b[2J\x1b[H❯ '+s+'\r\n');
let input='',seed='',submitted=false;
process.stdin.setRawMode(true);process.stdin.resume();
const hint='Try "refactor <filepath>"';
if(scenario==='startup-prior-conversation')append('user',text('An earlier request'));
if(scenario==='startup-terminal-placeholder-cursor')frame(process.env.TERM==='dumb'||!process.env.TERM?hint:'\x1b[7mT\x1b[27m\x1b[2m'+hint.slice(1)+'\x1b[22m');
else if(scenario==='startup-placeholder-cursor')frame('\x1b[7mT\x1b[27m\x1b[2m'+hint.slice(1)+'\x1b[22m');
else if(scenario==='startup-placeholder-unicode')frame('\x1b[2mTry "refactor src/設定.ts"\x1b[22m');
else if(['startup-placeholder','startup-prior-conversation','startup-missing-styles','startup-waiting','startup-prose-question','startup-permission','startup-fresh-waiting'].includes(scenario))frame('\x1b[2m'+hint+'\x1b[22m');
else if(scenario==='startup-typed-hint')frame(hint);
else if(scenario==='startup-partial-dim')frame('\x1b[2mTry \x1b[22m"refactor <filepath>"');
else frame('');
if(scenario==='startup-prose-question')process.stdout.write('Which option do you prefer?\r\nA) Full review (recommended)\r\nB) Skip review\r\n');
if(scenario==='startup-permission')process.stdout.write('Bash command run checks requires permission\r\n');
process.stdin.on('data',chunk=>{
 input+=chunk.toString();
 if(input.startsWith('\x1b[200~')&&input.endsWith('\x1b[201~')){
  seed=input.slice(6,-6);input='';event('paste',seed);
  frame('[Pasted text #1 +'+(seed.match(/\n/g)||[]).length+' lines]');return;
 }
 if(input==='\r'&&!submitted){
  submitted=true;input='';event('enter',seed);frame('');
  if(scenario==='no-ack')return;
  append('user',text(scenario==='fused'?seed+'\n/plan-eng-review':seed));
  if(scenario==='duplicate')append('user',text(seed));
  if(scenario==='session-switch'){status.sessionId='bbbbbbbb-1111-2222-3333-aaaaaaaaaaaa';fs.writeFileSync(statusFile,JSON.stringify(status));return;}
  if(scenario==='foreign-cwd'){fs.writeFileSync(file,row('user',text(seed)).replace(cwd,cwd+'-other'));return;}
  if(scenario==='pending-tool'||scenario==='completed-tool'||scenario==='question'){
   append('assistant',[{type:'tool_use',id:'call1',name:scenario==='question'?'AskUserQuestion':'Read',input:{}}],'tool_use');
  }
  if(scenario==='status-updating'){fs.writeFileSync(statusFile,'{\"pid\":');setTimeout(()=>fs.writeFileSync(statusFile,JSON.stringify(status)),120);}
  if(scenario==='permission'){status.waitingFor='permission prompt';fs.writeFileSync(statusFile,JSON.stringify(status));}
  setTimeout(()=>{
   if(scenario==='no-end-turn')return;
   if(scenario==='completed-tool')append('user',[{type:'tool_result',tool_use_id:'call1',content:'Read complete'}]);
   append('assistant',text('Draft received; waiting for your skill command.'),'end_turn');event('end_turn',seed);
   if(scenario==='partial')fs.appendFileSync(file,'{"type":');
   frame(scenario==='prose-question' ? '\r\nWhich option do you prefer?\r\nA) Full review (recommended)\r\nB) Skip review\r\n❯ ' : '');
  },180);return;
 }
 if(input==='/plan-eng-review\r'){event('slash',input);input='';}
});
setTimeout(()=>process.exit(0),scenario==='wrong-pid'?12000:5000);
