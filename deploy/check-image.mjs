import { execFileSync } from 'node:child_process';
const images=process.argv.slice(2);
if(!images.length)throw new Error('Provide image names');
for(const image of images){
  const output=execFileSync('docker',['run','--rm','--entrypoint','node',image,'-e',String.raw`
    const fs=require('node:fs'),path=require('node:path');
    const forbidden=[];
    function walk(root){for(const row of fs.readdirSync(root,{withFileTypes:true})){if(row.name==='node_modules')continue;const file=path.join(root,row.name);
      if(row.name==='.git'||row.name==='.local'||row.name==='secrets'||row.name==='config.local.json'||/^\.env(?:\.|$)/.test(row.name)||row.name.endsWith('.sops')||/age\.key$/.test(row.name))forbidden.push(file);
      if(row.isDirectory())walk(file);
    }}walk('/app');
    for(const[name,value]of Object.entries(process.env))if(/DATABASE_URL|SESSION_SECRET|SOPS_AGE_KEY|OWNER_USER_ID/.test(name)&&value)forbidden.push('env:'+name);
    if(forbidden.length){console.error(forbidden.join('\n'));process.exit(1)}
    console.log('Image contains no runtime config, archives or credentials');
  `],{encoding:'utf8'});
  console.log(`${image}: ${output.trim()}`);
}
