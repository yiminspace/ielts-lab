import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exportArchive } from '../scripts/export-archive.mjs';

test('deployment export preserves material IDs while excluding account fields and unrelated files',async t=>{
 const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ielts-export-')));t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
 const root=path.join(temporary,'archive'),target=path.join(temporary,'export');
 await fs.mkdir(path.join(root,'data/整理/听力'),{recursive:true});await fs.mkdir(path.join(root,'data/media'),{recursive:true});
 const file=path.join(root,'data/整理/听力/original.json');
 const source=JSON.stringify({title:'Original test recording',data:{listeningId:'test-id',questions:[],userId:'private-account',nested:{token:'synthetic-token',useful:true}},localMedia:{}});
 await fs.writeFile(file,source);await fs.writeFile(path.join(root,'account.json'),JSON.stringify({password:'synthetic-password'}));
 const summary=await exportArchive(root,target);assert.ok(summary.materials>=1);
 const exported=JSON.parse(await fs.readFile(path.join(target,'data/整理/听力/original.json'),'utf8'));
 assert.equal(exported.data.userId,undefined);assert.equal(exported.data.nested.token,undefined);assert.equal(exported.data.nested.useful,true);
 await assert.rejects(fs.access(path.join(target,'account.json')));assert.equal(await fs.readFile(file,'utf8'),source);
 await assert.rejects(exportArchive(root,target),/EEXIST/);
});
test('deployment export refuses destinations inside the read-only original',async t=>{
 const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ielts-export-')));t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
 await fs.mkdir(path.join(temporary,'data/整理'),{recursive:true});await fs.mkdir(path.join(temporary,'data/media'),{recursive:true});
 await assert.rejects(exportArchive(temporary,path.join(temporary,'export')),/separate/);
});
