const fs=require('fs');
function strings(f){
  let s=fs.readFileSync(f,'utf8');
  s=s.replace(/<%[\s\S]*?%>/g,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ');
  const o=new Set();
  for(const m of s.matchAll(/>([^<>]*)</g)){const t=m[1].trim();if(t&&/[\u0980-\u09FF]/.test(t))o.add(t);}
  for(const m of s.matchAll(/(?:placeholder|title|alt|aria-label)="([^"]*)"/g))if(/[\u0980-\u09FF]/.test(m[1]))o.add(m[1]);
  return [...o];
}
for(const f of process.argv.slice(2)){console.log('=== '+f);strings(f).forEach(x=>console.log(JSON.stringify(x)));}
