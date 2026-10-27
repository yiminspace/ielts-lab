import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("./dist/", import.meta.url));
const inside = (file) => file.startsWith(root);
const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png", ".ico":"image/x-icon", ".woff2":"font/woff2" };
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const server=http.createServer(async(req,res)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://api.yiminlab.site; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if(!["GET","HEAD"].includes(req.method)){res.writeHead(405);return res.end();}
  let route;try{route=decodeURIComponent((req.url||"/").split("?")[0]);}catch{res.writeHead(400);return res.end();}
  if(route==="/health"){
    const body=JSON.stringify({status:"ok",service:"ielts-web",version:process.env.GIT_SHA||"dev"});
    res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});return res.end(req.method==="HEAD"?undefined:body);
  }
  if(route.includes("\\")||route.includes("\0")||route.split("/").some(v=>v.startsWith(".")&&v!=="")){res.writeHead(404);return res.end();}
  if(/^\/(api|media)(?:\/|$)/.test(route)){res.writeHead(404);return res.end();}
  let target=path.join(root,route.replace(/^\/+/,"")||"index.html");
  try{
    try{target=await fs.realpath(target);}catch{
      if(path.extname(route)){res.writeHead(404);return res.end();}
      target=await fs.realpath(path.join(root,"index.html"));
    }
    if(!inside(target)||(await fs.stat(target)).isDirectory()){res.writeHead(404);return res.end();}
    const stat=await fs.stat(target);
    res.writeHead(200,{"Content-Type":types[path.extname(target)]||"application/octet-stream","Content-Length":stat.size,
      "Cache-Control":route.startsWith("/assets/")?"public,max-age=31536000,immutable":"no-store"});
    if(req.method==="HEAD")return res.end();
    const stream=createReadStream(target);stream.on("error",()=>res.destroy());res.on("close",()=>stream.destroy());stream.pipe(res);
  }catch{res.writeHead(404);res.end();}
});
server.requestTimeout=30000;server.headersTimeout=10000;
server.listen(port,process.env.HOST||"127.0.0.1");
for(const signal of["SIGTERM","SIGINT"])process.on(signal,()=>server.close(()=>process.exit(0)));
