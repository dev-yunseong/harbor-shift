import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDockerRun,parseCompose,splitCommand,loadSource } from '../src/service-source.js';
import { loadProxyConfig } from '../src/proxy-config.js';
import { Docker } from '../src/docker.js';
const image='example/web:stable';
const model=(extra={})=>({services:{web:{image,ports:[{target:8081,published:'9000',protocol:'tcp',mode:'ingress'}],environment:{SLOT:'green'},networks:{app:null},...extra}},networks:{app:{name:'demo'}}});
const withFile=async (text,fn)=>{
 const dir=await mkdtemp(join(tmpdir(),'hs-source-'));
 try { const file=join(dir,'harbor.yml');await writeFile(file,text);return await fn(file,dir); }
 finally {await rm(dir,{recursive:true,force:true});}
};

test('docker run import preserves quoted arguments without invoking a shell',()=>{
 const s=parseDockerRun(`docker run -d --name original --restart always --network demo --memory 512m --cpus 0.5 -p 9000:8080 -e 'MESSAGE=hello world' --env-file app.env --entrypoint node -v /srv/config:/config:ro ${image} app.js 'literal;value'`, '/config');
 assert.equal(s.image,image);assert.deepEqual(s.ports,[8080]);assert.equal(s.memory,'512m');
 assert.deepEqual(s.container.env,['MESSAGE=hello world']);assert.deepEqual(s.container.command,['app.js','literal;value']);
 assert.deepEqual(s.container.mounts,[{source:'/srv/config',target:'/config'}]);
 assert.deepEqual(s.container.entrypoint,['node']);
 assert.throws(()=>splitCommand(`docker run ${image} $(touch marker)`),/unsupported/);
 assert.throws(()=>splitCommand(`docker run ${image}; echo secret`),/unsupported/);
 assert.deepEqual(splitCommand(`docker run \\\n -e 'TOKEN=$literal' ${image}`),['docker','run','-e','TOKEN=$literal',image]);
});

test('unsupported run options and unsafe shared storage are rejected',()=>{
 for(const options of ['--privileged','--network host','-v /srv/data:/data:rw','--mount type=bind,src=/srv/data,dst=/data','--label harbor-shift.group=other','-p 9000:8080/udp','--network first --net second']) {
  assert.throws(()=>parseDockerRun(`docker run ${options} ${image}`,'/config'));
 }
});

test('Compose import selects one service and retains command, environment and read-only mounts',()=>{
 const s=parseCompose(model({command:['node','app.js'],volumes:[{type:'bind',source:'/srv/config',target:'/config',read_only:true,bind:{create_host_path:true}}],mem_limit:'268435456'}),'web');
 assert.equal(s.memory,'256m');assert.equal(s.network,'demo');assert.deepEqual(s.container.command,['node','app.js']);
 assert.deepEqual(s.container.env,['SLOT=green']);assert.deepEqual(s.ports,[8081]);
 assert.throws(()=>parseCompose({services:{a:{image},b:{image}}}),/service is required/);
 for(const extra of [{build:'.'},{privileged:true},{depends_on:{db:{condition:'service_started'}}},{volumes:[{type:'volume',source:'data',target:'/data'}]}]) assert.throws(()=>parseCompose(model(extra),'web'),/Unsupported|Only/);
});

test('Compose canonicalization is read-only, bounded, and redacts failures',async()=>{
 let call;
 const s=await loadSource({composeFile:'app.yml',service:'web'},'/config',async(...args)=>{call=args;return {stdout:JSON.stringify(model())};});
 assert.equal(s.image,image);assert.equal(call[0],'docker');assert.ok(call[1].includes('config'));assert.ok(!call[1].includes('up'));assert.equal(call[2].shell,false);
 await assert.rejects(loadSource({composeFile:'app.yml'},'/config',async()=>{throw Error('secret-value');}),e=>/redacted/.test(e.message)&&!e.message.includes('secret-value'));
});

test('YAML supports mixed slot sources with distinct ports and environment',async()=>{
 await withFile(`group: demo\nnetwork: demo\nslots:\n  blue:\n    source:\n      dockerRun: docker run --network demo -p 8000:8080 -e SLOT=blue ${image}\n  green:\n    source:\n      composeFile: green.yml\n      service: web\nshutdown:\n  mode: http\n  request:\n    path: /shutdown\n`,async file=>{
  const c=await loadProxyConfig(file,async()=>({stdout:JSON.stringify(model())}));
  assert.equal(c.slots.blue.url,'http://demo-blue:8080');assert.equal(c.slots.green.url,'http://demo-green:8081');
  assert.deepEqual(c.slots.blue.container.env,['SLOT=blue']);assert.deepEqual(c.slots.green.container.env,['SLOT=green']);
  assert.equal(c.shutdown.initiate.type,'http');assert.equal(c.shutdown.completion.type,'exit');assert.equal(c.timing.drainMs,3600000);
  const calls=[],d=new Docker(c,async(_,args)=>{calls.push(args);return {stdout:args.includes('image')?'[{"Config":{"Volumes":{}}}]':''};});
  await d.prepare('green',`sha256:${'a'.repeat(64)}`);
  const create=calls.find(a=>a.includes('create'));
  assert.ok(create.includes('SLOT=green'));assert.ok(!create.includes('--publish'));assert.ok(create.includes('demo-green'));assert.equal(create[create.indexOf('--restart')+1],'no');
 });
});

test('slot sources reject differing image tags, mismatched networks and ambiguous ports',async()=>{
 const text=(blue,green)=>`group: demo\nnetwork: demo\nslots:\n  blue:\n    source:\n      dockerRun: ${blue}\n  green:\n    source:\n      dockerRun: ${green}\n`;
 for(const green of [`docker run -p 8080:80 other/image:stable`,`docker run --network other -p 8080:80 ${image}`,`docker run -p 8080:80 -p 9090:90 ${image}`]) {
  await withFile(text(`docker run -p 8080:80 ${image}`,green),file=>assert.rejects(loadProxyConfig(file)));
 }
});

test('YAML errors do not print source secrets and JSON compatibility is retained',async()=>{
 await withFile('group: secret-value\ngroup: duplicate\n',file=>assert.rejects(loadProxyConfig(file),e=>!e.message.includes('secret-value')));
 assert.equal((await loadProxyConfig('examples/proxy/service.json')).group,'harbor-web');
});

test('Compose empty command clears image CMD instead of silently running it',async()=>{
 await withFile(`group: demo\nnetwork: demo\nsource:\n  composeFile: app.yml\n`,async file=>{
  const c=await loadProxyConfig(file,async()=>({stdout:JSON.stringify(model({command:[]}))}));
  const calls=[],d=new Docker(c,async(_,args)=>{calls.push(args);return {stdout:args.includes('image')?'[{"Config":{"Volumes":{},"Entrypoint":["node"],"Cmd":["unexpected.js"]}}]':''};});
  await d.prepare('blue',`sha256:${'b'.repeat(64)}`);
  const args=calls.find(x=>x.includes('create'));assert.equal(args[args.indexOf('--entrypoint')+1],'node');assert.ok(!args.includes('unexpected.js'));
 });
});

test('default YAML source preserves HTTP port 80 when URL normalization omits it',async()=>{
 const c=await loadProxyConfig('harbor.yml');
 assert.equal(c.slots.blue.url,'http://harbor-web-blue:80');
 assert.equal(c.shutdown.completion.type,'proxy');
});

test('two docker run sources retain distinct commands and environment',async()=>{
 await withFile(`group: demo\nnetwork: demo\nslots:\n  blue:\n    source:\n      dockerRun: docker run -p 80:80 -e SLOT=blue ${image} blue.js\n  green:\n    source:\n      dockerRun: docker run -p 81:81 -e SLOT=green ${image} green.js\n`,async file=>{
  const c=await loadProxyConfig(file);
  assert.deepEqual(c.slots.blue.container.command,['blue.js']);
  assert.deepEqual(c.slots.green.container.command,['green.js']);
  assert.equal(c.slots.green.url,'http://demo-green:81');
 });
});
