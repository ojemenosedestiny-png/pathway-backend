// Cloudflare Worker: bind the private pathway-files R2 bucket as MEDIA_BUCKET.
// No API keys belong in this file. Only server-scanned public/ objects are served.
export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response('Method not allowed', {status:405, headers:{Allow:'GET, HEAD'}});
    const key = new URL(request.url).pathname.slice(1);
    if (!/^public\/[a-f0-9-]{36}\/[^/]+$/i.test(key))
      return new Response('Not found', {status:404});
    if (!env.MEDIA_BUCKET) return new Response('Media storage is not connected', {status:503});
    try {
      const head = await env.MEDIA_BUCKET.head(key);
      if (!head) return new Response('Not found', {status:404});
      const type = head.httpMetadata?.contentType;
      if (!['image/jpeg','image/png','image/webp','video/mp4','video/webm','application/pdf'].includes(type))
        return new Response('Not found', {status:404});
      const headers = new Headers({'Content-Type':type,'X-Content-Type-Options':'nosniff',
        'Cache-Control':'public, max-age=300','Accept-Ranges':'bytes','ETag':head.httpEtag,
        'Content-Security-Policy':"default-src 'none'; sandbox"});
      let offset=0, length=head.size, status=200;
      const range=request.method==='GET'?request.headers.get('range'):null;
      if(range){
        const match=/^bytes=(\d*)-(\d*)$/.exec(range);
        if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+head.size}});
        if(!match[1]){length=Math.min(Number(match[2]),head.size);offset=head.size-length;}
        else{offset=Number(match[1]);const end=match[2]?Math.min(Number(match[2]),head.size-1):head.size-1;length=end-offset+1;}
        if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||offset>=head.size||length<=0)
          return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+head.size}});
        status=206;headers.set('Content-Range',`bytes ${offset}-${offset+length-1}/${head.size}`);
      }
      headers.set('Content-Length',String(length));
      if(request.method==='HEAD')return new Response(null,{headers});
      const object=await env.MEDIA_BUCKET.get(key,status===206?{range:{offset,length}}:undefined);
      if(!object)return new Response('Not found',{status:404});
      return new Response(object.body,{status,headers});
    }catch{return new Response('Media is temporarily unavailable',{status:503});}
  }
};
