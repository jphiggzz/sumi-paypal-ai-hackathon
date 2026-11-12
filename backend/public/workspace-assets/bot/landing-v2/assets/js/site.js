/*!
 * site.js — landing page behaviors.
 * Replaces everything Framer's runtime used to do, with zero dependencies:
 *   - appear animations (original params, embedded below)
 *   - hero headline word reveal
 *   - seamless marquee loops
 *   - FAQ accordion
 *   - pricing monthly/yearly toggle ($2/$5 → $20/$50, 2 months free)
 *   - mobile menu
 *   - contact form (success state)
 *   - footer light/dark theme toggle (html.dark + localStorage)
 *   - hero ASCII field: 2-pass WebGL (liquid noise wave → glyph cells),
 *     matching the Framer/OGL shader stack from the original export
 *   - image guard: imgs and canvases are view-only (no drag, no right-click save)
 * Respects prefers-reduced-motion throughout.
 */(function(){"use strict";var k=window.matchMedia("(prefers-reduced-motion: reduce)").matches,$="cubic-bezier(0.34, 1.36, 0.64, 1)";document.addEventListener("dragstart",function(i){var r=i.target;r&&(r.tagName==="IMG"||r.tagName==="CANVAS")&&i.preventDefault()}),document.addEventListener("contextmenu",function(i){var r=i.target;r&&(r.tagName==="IMG"||r.tagName==="CANVAS")&&i.preventDefault()});/* Entrance motion lives in /entrance.js. */(function(){var i=38,r=document.querySelectorAll(".ff-marquee");function e(t){var c=t.children;if(!c.length)return 0;var l=parseFloat(getComputedStyle(t).gap)||0,m=c[0],f=c[c.length-1];return f.offsetLeft+f.offsetWidth+l-m.offsetLeft}function a(t,c){if(t.dataset.ffMarquee==="1"||k||typeof t.animate!="function")return!0;if(!t.getClientRects().length)return!1;var l=e(t);if(l<8)return!1;t.dataset.ffMarquee="1",t.parentElement&&t.parentElement.classList.add("ff-marquee-host"),Array.prototype.slice.call(t.children).forEach(function(v){t.appendChild(v.cloneNode(!0))});var m=c?-l:0,f=c?0:-l;return t.animate([{transform:"translate3d("+m+"px,0,0)"},{transform:"translate3d("+f+"px,0,0)"}],{duration:l/i*1e3,iterations:1/0,easing:"linear"}),!0}function n(){r.forEach(function(t,c){var l=c%2===1;if(!a(t,l)&&typeof ResizeObserver=="function"){var m=new ResizeObserver(function(){a(t,l)&&m.disconnect()});m.observe(t)}})}document.fonts&&document.fonts.ready?document.fonts.ready.then(n,n):n()})(),(function(){var i=document.getElementById("faq");if(!i)return;var r=".framer-1n043u9",e=1e4;function a(n){var t=n.getAttribute("data-framer-name")==="Open";n.setAttribute("data-framer-name",t?"Closed":"Open"),n.setAttribute("aria-expanded",t?"false":"true"),n.classList.toggle("framer-v-4fcvvz",!t),n.classList.toggle("framer-v-170rlbg",t),n.style.setProperty("--border-color",t?"var(--token-8c44f4b6-1a43-4e77-81dd-af1d7863529c, rgb(230, 230, 230))":"rgba(230, 230, 230, 0)"),n.style.backgroundColor=t?"rgba(255, 255, 255, 0)":"rgb(255, 255, 255)",n.style.boxShadow=t?"none":"0px 0px 0px 1px rgba(0, 0, 0, 0.05), 0px 1px 1px 0px rgba(0, 0, 0, 0.05), 0px 1px 2px -0.5px rgba(0, 0, 0, 0.05), 0px 2px 4px -1.5px rgba(0, 0, 0, 0.05)";var c=n.querySelector(r);c&&(c.style.opacity=t?"0":"1",c.style.filter=t?"blur(5px)":"blur(0px)",c.style.webkitFilter=t?"blur(5px)":"blur(0px)",c.style.pointerEvents=t?"none":"auto",c.style.setProperty("--extracted-r6o4lv",t?"var(--token-ea5c1554-743c-46cf-939d-d8d8b48ee669, rgb(126, 126, 126))":"var(--token-7ad37dfa-1d60-444e-8118-a7dc147af84e, rgb(122, 122, 122))"));var l=n.querySelector(".framer-ax1xuv");l&&(l.style.rotate=t?"0deg":"-45deg"),n._faqTimer&&(clearTimeout(n._faqTimer),n._faqTimer=null),t||(n._faqTimer=setTimeout(function(){n._faqTimer=null,n.getAttribute("data-framer-name")==="Open"&&a(n)},e))}i.addEventListener("click",function(n){var t=n.target.closest(".framer-xZrkI");t&&a(t)}),i.addEventListener("keydown",function(n){if(!(n.key!=="Enter"&&n.key!==" ")){var t=n.target.closest(".framer-xZrkI");t&&n.target===t&&(n.preventDefault(),a(t))}})})(),(function(){var i=document.getElementById("pricing");if(!i||i.getAttribute("data-interval")==="once"||!i.querySelector(".framer-9PL1x"))return;var r=!0;i.setAttribute("data-interval","month");function e(c,l){var m=Array.prototype.find.call(c.childNodes,function(f){return f.nodeType===Node.TEXT_NODE&&/\$\d+/.test(f.nodeValue||"")});m&&(m.nodeValue=l+" ")}function a(c){i.setAttribute("data-interval",c?"quarter":"month"),i.querySelectorAll(".framer-9PL1x").forEach(function(l){var m=l.getAttribute("data-plan");if(!(m!=="basic"&&m!=="pro")){l.classList.add("framer-v-171nnn4"),l.classList.remove("framer-v-1thxaxt"),l.setAttribute("data-framer-name",c?"Quarterly":"Monthly");var f=l.querySelector(".framer-j9of2e h3, .framer-j9of2e .framer-text")||l.querySelector(".framer-j9of2e");f&&(f.setAttribute("aria-live","polite"),f.setAttribute("aria-atomic","true"),e(f,m==="pro"?c?"$23":"$29":"$0"));var v=l.querySelector(".ff-was");v&&(v.textContent="");var d=l.querySelector(".framer-17uh44g p, .framer-17uh44g .framer-text")||l.querySelector(".framer-17uh44g");d&&(d.textContent="/month");var billing=l.querySelector(".ff-billing-detail");billing&&(billing.textContent=c?"$69 billed every 3 months":"$29 billed every month");var discount=l.querySelector(".ff-discount");discount&&(discount.textContent=m==="pro"?(c?"SAVE $18":"MONTHLY"):"FREE");var h=l.querySelector('a[href*="/continue?"]');h&&(h.href="/signup")}}),i.querySelectorAll(".framer-yTrmr").forEach(function(l){l.classList.toggle("framer-v-njodba",!c),l.setAttribute("data-framer-name",c?"on":"off"),l.setAttribute("role","switch"),l.setAttribute("aria-checked",c?"true":"false"),l.style.backgroundColor=c?"rgb(0, 0, 0)":"rgb(219, 219, 219)"})}function n(){r=!r,a(r)}function t(c){return c.closest(".framer-1gp8bk0")||c.closest(".framer-yTrmr")}a(!0),i.addEventListener("click",function(c){t(c.target)&&n()}),i.addEventListener("keydown",function(c){c.key!=="Enter"&&c.key!==" "||!t(c.target)||(c.preventDefault(),n())})})(),(function(){var i=document.getElementById("features");if(!i)return;var r={desktop:"framer-v-1gmjaaq",tablet:"framer-v-e8sqq7",mobile:"framer-v-16t7006"},e={desktop:"framer-v-1hoezpk",tablet:"framer-v-1qdkqc5",mobile:"framer-v-es41lb"},a={desktop:"framer-v-1c6tay4",tablet:"framer-v-48s9on",mobile:"framer-v-m72yja"},n=["framer-v-1gmjaaq","framer-v-e8sqq7","framer-v-16t7006"],t=["framer-v-1hoezpk","framer-v-1qdkqc5","framer-v-es41lb","framer-v-1c6tay4","framer-v-48s9on","framer-v-m72yja"],c={desktop:"Desktop",tablet:"Tablet",mobile:"Mobile"};function l(f){return f.classList.contains("framer-v-1c6tay4")||f.classList.contains("framer-v-48s9on")||f.classList.contains("framer-v-m72yja")}function m(f,v){n.forEach(function(C){f.classList.remove(C)}),f.classList.add(r[v]);var d=f.querySelector(".framer-1canp88"),h=f.querySelector(".framer-l3jexs"),_=f.querySelector(".framer-1q90dd0");d&&(d.style.opacity=v==="desktop"?"1":"0.4"),h&&(h.style.opacity=v==="tablet"?"1":"0.4"),_&&(_.style.opacity=v==="mobile"?"1":"0.4");var g=f.closest(".framer-dBjgL");if(g){g.getAttribute("data-ff-device-map")||g.setAttribute("data-ff-device-map",l(g)?"compact":"large");var E=g.getAttribute("data-ff-device-map")==="compact"?a:e;t.forEach(function(C){g.classList.remove(C)}),g.classList.add(E[v]),g.setAttribute("data-framer-name",c[v])}}i.addEventListener("click",function(f){var v=f.target.closest(".framer-uHSrw");!v||!i.contains(v)||(f.target.closest(".framer-1wh8w9p")?m(v,"desktop"):f.target.closest(".framer-z6njrf")?m(v,"tablet"):f.target.closest(".framer-cwr7xn")&&m(v,"mobile"))}),i.addEventListener("keydown",function(f){if(!(f.key!=="Enter"&&f.key!==" ")){var v=f.target.closest(".framer-1wh8w9p, .framer-z6njrf, .framer-cwr7xn");if(v){var d=v.closest(".framer-uHSrw");d&&(f.preventDefault(),v.classList.contains("framer-1wh8w9p")?m(d,"desktop"):v.classList.contains("framer-z6njrf")?m(d,"tablet"):m(d,"mobile"))}}})})(),(function(){var i=document.getElementById("ff-menu"),r=document.getElementById("ff-menu-backdrop"),e=document.querySelector(".framer-puef3e");if(!i||!r||!e)return;var a=!1;function n(t){a=t,i.hidden=!t,r.hidden=!t,document.body.classList.toggle("ff-menu-open",t),e.setAttribute("aria-expanded",String(t))}e.addEventListener("click",function(){n(!a)}),i.addEventListener("click",function(t){t.target.closest("a")&&n(!1)}),r.addEventListener("click",function(){n(!1)}),document.addEventListener("keydown",function(t){t.key==="Escape"&&n(!1)})})(),(function(){var i=document.documentElement,r=document.querySelectorAll(".ff-theme-toggle");function e(a,n){if(i.classList.toggle("dark",a),i.style.colorScheme=a?"dark":"light",r.forEach(function(t){t.setAttribute("aria-pressed",String(a)),t.setAttribute("title",a?"Switch to light mode":"Switch to dark mode");var c=t.querySelector(".ff-theme-label");c&&(c.textContent=a?"Light":"Dark")}),n)try{localStorage.setItem("tovi-demo-theme",a?"dark":"light"),window.dispatchEvent(new Event("tovi-demo-theme-change"))}catch{}}r.forEach(function(a){a.addEventListener("click",function(){e(!i.classList.contains("dark"),!0)})}),e(i.classList.contains("dark"),!1)})(),(function(){var i=document.querySelectorAll("form.framer-v8008l");if(!i.length)return;function r(a){return a.querySelector(".framer-text")||a}function e(a,n){r(a).textContent=n}Array.prototype.forEach.call(i,function(a){a.getAttribute("data-ff-bound")||(a.setAttribute("data-ff-bound","1"),a.addEventListener("submit",function(n){if(n.preventDefault(),!a.checkValidity()){a.reportValidity();return}var t=a.querySelector('button[type="submit"]');if(!(!t||t.disabled)){var c=a.querySelector('input[type="text"][name="Name"]'),l=a.querySelector('input[type="email"]'),m=a.querySelector('textarea[name="Message"]'),f=a.querySelector('input[name="ff_hp"]')||a.querySelector('input[name="website"]'),v=(r(t).textContent||"Submit").trim()||"Submit";e(t,"Sending\u2026"),t.disabled=!0,t.setAttribute("aria-busy","true");var d=a.querySelector(".ff-contact-status");d||(d=document.createElement("p"),d.className="ff-contact-status",d.setAttribute("role","status"),d.setAttribute("aria-live","polite"),t.parentNode?t.parentNode.appendChild(d):a.appendChild(d)),d.textContent="",d.removeAttribute("data-state"),Promise.resolve({ok:true,json:function(){return Promise.resolve({})}}).then(function(h){return h.json().catch(function(){return{}}).then(function(_){return{ok:h.ok,body:_}})}).then(function(h){if(!h.ok)throw new Error(h.body&&h.body.error||"Could not send your message. Please try again.");e(t,"Preview complete"),d.textContent="Preview only. Your message has not been sent.",d.setAttribute("data-state","ok"),setTimeout(function(){e(t,v),t.disabled=!1,t.removeAttribute("aria-busy")},4e3)}).catch(function(h){e(t,v),t.disabled=!1,t.removeAttribute("aria-busy"),d.textContent=h&&h.message?h.message:"Could not send your message right now. Please try again in a moment.",d.setAttribute("data-state","err")})}}))})})(),(function(){var i=document.getElementById("pricing");if(!i||i.getAttribute("data-interval")==="once"||!i.querySelector(".framer-9PL1x"))return;function r(a){return a&&a.getAttribute("data-plan")==="pro"?"pro":"basic"}var e=i.querySelectorAll("div[data-framer-name], p");Array.prototype.forEach.call(e,function(a){(a.textContent||"").trim()==="Get Started"&&(a.style.cursor="pointer",a.addEventListener("click",function(n){n.preventDefault(),n.stopPropagation();var t=a.closest(".framer-9PL1x"),c=t?r(t):"basic",l=i.getAttribute("data-interval")==="year"?"year":"month";window.location.href="/signup"}))})})();var Q=function(){var i=document.querySelector(".framer-1pn4jri-container"),r=document.querySelector(".ff-hero-canvas");if(!i||!r)return;var e=r.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1,preserveDrawingBuffer:!1})||null;if(!e){r.style.background=document.documentElement.classList.contains("dark")?"radial-gradient(ellipse 70% 55% at 50% 40%, rgba(255,255,255,0) 0%, rgba(255,255,255,0.03) 70%, rgba(255,255,255,0.06) 100%)":"radial-gradient(ellipse 70% 55% at 50% 40%, rgba(255,255,255,0) 0%, rgba(0,0,0,0.04) 70%, rgba(0,0,0,0.08) 100%)";return}var a=2.15,n=k?0:.32,t=1.15,c=5,l=.95,m=.08;function f(p,x){var b=e.createShader(p);return e.shaderSource(b,x),e.compileShader(b),e.getShaderParameter(b,e.COMPILE_STATUS)?b:(console.warn("hero shader",e.getShaderInfoLog(b)),e.deleteShader(b),null)}function v(p,x){var b=f(e.VERTEX_SHADER,p),T=f(e.FRAGMENT_SHADER,x);if(!b||!T)return null;var o=e.createProgram();return e.attachShader(o,b),e.attachShader(o,T),e.linkProgram(o),e.getProgramParameter(o,e.LINK_STATUS)?o:(console.warn("hero program",e.getProgramInfoLog(o)),null)}var d=`#version 300 es
in vec2 position;
out vec2 vUv;
void main(){
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`,h=`#version 300 es
precision highp float;
uniform float uFrequency,uTime,uSpeed,uValue;
uniform vec2 uResolution;
in vec2 vUv;
out vec4 fragColor;

// Approved subtle swell + foam preview; retain the existing glyph pass.
const float WATERINESS = .22;
const float FOAM = .55;

vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.); const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=1./7.; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.; vec4 s1=floor(b1)*2.+1.; vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.); m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float noise(vec2 p,float t){return snoise(vec3(p,t));}

void main(){
  vec2 uv=vUv;
  float aspect=uResolution.x/max(uResolution.y,1.);
  vec2 q=(uv-.5)*vec2(aspect,1.);
  float t=uTime*uSpeed;

  // Gently advect the original two-layer liquid noise into broad swells.
  vec2 source=(q+.5)*uFrequency;
  source.x-=t*.07*WATERINESS;
  source.y=source.y*(1.+WATERINESS*.85)+WATERINESS*(.24*sin(q.x*2.8-t*.5)+.10*noise(q*1.3,t*.23));
  float water1=abs(noise(source,t));
  float water2=abs(noise(source*2.15+2.7,t*1.2+1.3));
  float liquid=clamp(water1*.85+water2*.55,0.,1.);
  float phase=q.y*19.+sin(q.x*2.8-t*.48)*1.8-t*.9+noise(q*1.4,t*.23)*.4;
  float swell=.5+.5*sin(phase);
  float water=mix(liquid,pow(swell,2.)*.80+liquid*.20,WATERINESS*.65);

  // Sparse foam blooms briefly at the lower crests, using the same glyphs.
  float crest=pow(.5+.5*sin(phase+.17),30.);
  float foamPatch=smoothstep(.22,.64,noise(vec2(q.x*3.8-t*.4,q.y*2.8)+7.,t*.25));
  float breath=smoothstep(.32,.85,sin(t*2.1+q.x*1.4));
  float flecks=smoothstep(-.10,.65,noise(q*45.+vec2(-t*.65,t*.2),t*.4));
  float bottom=1.-smoothstep(.30,.65,uv.y);
  float foam=crest*foamPatch*breath*flecks*bottom*FOAM*.65;

  // Preserve the original quiet center and overall density.
  vec2 p=(uv-.5)*vec2(.95,1.15);
  float vig=smoothstep(.18,.92,length(p));
  float value=(mix(.12,1.,water)+foam)*vig;
  fragColor=vec4(vec3(clamp(value*uValue,0.,1.)),1.);
}
`,_=`#version 300 es
precision highp float;
uniform vec2 uResolution; uniform sampler2D uTexture;
uniform float uCellSize,uGamma,uPaletteBias;
uniform vec3 uGlyphColor; uniform float uGlyphAlpha;
out vec4 fragColor;
float character(int n, vec2 p){
  p=floor(p*vec2(-4.,4.)+2.5);
  if(clamp(p.x,0.,4.)==p.x && clamp(p.y,0.,4.)==p.y){
    int a=int(round(p.x)+5.*round(p.y));
    if(((n>>a)&1)==1) return 1.;
  }
  return 0.;
}
void main(){
  vec2 pix=gl_FragCoord.xy;
  float quant=max(uCellSize*2.,1.);
  vec3 col=texture(uTexture, floor(pix/quant)*quant/uResolution.xy).rgb;
  float gray=dot(col, vec3(.3,.59,.11));
  gray=pow(clamp(gray,1e-4,1.), uGamma);
  float cell=max(uCellSize,1.);
  int n=4096;
  if(gray>.2) n=65600;
  if(gray>.3) n=163153;
  if(gray>.4) n=15255086;
  if(gray>.5) n=13121101;
  if(gray>.6) n=15252014;
  if(gray>.7) n=13195790;
  if(gray>.8) n=11512810;
  vec2 p=mod(pix/cell,2.)-vec2(1.);
  float charAlpha=character(n,p);
  float a=charAlpha * smoothstep(.01,.14,gray) * uGlyphAlpha;
  fragColor=vec4(uGlyphColor, a);
}
`,g=v(d,h),E=v(d,_);if(!g||!E)return;var C=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,C),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),e.STATIC_DRAW);function j(p){var x=e.getAttribLocation(p,"position");e.bindBuffer(e.ARRAY_BUFFER,C),e.enableVertexAttribArray(x),e.vertexAttribPointer(x,2,e.FLOAT,!1,0,0)}var X=e.createFramebuffer(),S=e.createTexture(),y=0,R=0;function F(p,x){y=Math.max(2,p),R=Math.max(2,x),e.bindTexture(e.TEXTURE_2D,S),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,y,R,0,e.RGBA,e.UNSIGNED_BYTE,null),e.bindFramebuffer(e.FRAMEBUFFER,X),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,S,0),e.bindFramebuffer(e.FRAMEBUFFER,null)}var w={uFrequency:e.getUniformLocation(g,"uFrequency"),uTime:e.getUniformLocation(g,"uTime"),uSpeed:e.getUniformLocation(g,"uSpeed"),uValue:e.getUniformLocation(g,"uValue"),uResolution:e.getUniformLocation(g,"uResolution")},A={uResolution:e.getUniformLocation(E,"uResolution"),uTexture:e.getUniformLocation(E,"uTexture"),uCellSize:e.getUniformLocation(E,"uCellSize"),uGamma:e.getUniformLocation(E,"uGamma"),uPaletteBias:e.getUniformLocation(E,"uPaletteBias"),uGlyphColor:e.getUniformLocation(E,"uGlyphColor"),uGlyphAlpha:e.getUniformLocation(E,"uGlyphAlpha")},U=0,z=!0,I=0;function P(){var p=Math.min(2,window.devicePixelRatio||1),x=i.clientWidth,b=i.clientHeight;if(!(!x||!b)){var T=Math.round(x*p),o=Math.round(b*p);(r.width!==T||r.height!==o)&&(r.width=T,r.height=o,r.style.width=x+"px",r.style.height=b+"px",F(T,o))}}function L(p,x){if(!(!z&&!x)){if(!x&&p-I<32){U=requestAnimationFrame(L);return}I=p,P();var b=r.width,T=r.height,o=k?0:p*.001;e.bindFramebuffer(e.FRAMEBUFFER,X),e.viewport(0,0,y,R),e.useProgram(g),j(g),e.uniform1f(w.uFrequency,a),e.uniform1f(w.uTime,o),e.uniform1f(w.uSpeed,n),e.uniform1f(w.uValue,t),e.uniform2f(w.uResolution,y,R),e.drawArrays(e.TRIANGLES,0,3),e.bindFramebuffer(e.FRAMEBUFFER,null),e.viewport(0,0,b,T),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),e.enable(e.BLEND),e.blendFunc(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA),e.useProgram(E),j(E),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,S),e.uniform1i(A.uTexture,0),e.uniform2f(A.uResolution,b,T),e.uniform1f(A.uCellSize,c*Math.min(2,window.devicePixelRatio||1)),e.uniform1f(A.uGamma,l),e.uniform1f(A.uPaletteBias,m),document.documentElement.classList.contains("dark")?(e.uniform3f(A.uGlyphColor,182/255,179/255,171/255),e.uniform1f(A.uGlyphAlpha,.42)):(e.uniform3f(A.uGlyphColor,82/255,80/255,75/255),e.uniform1f(A.uGlyphAlpha,.6)),e.drawArrays(e.TRIANGLES,0,3),!k&&!x&&(U=requestAnimationFrame(L))}}new MutationObserver(function(){L(performance.now(),!0)}).observe(document.documentElement,{attributes:!0,attributeFilter:["class"]}),P(),L(performance.now(),!0),k||(U=requestAnimationFrame(L)),window.addEventListener("resize",function(){P(),k?(I=0,requestAnimationFrame(L)):z||L(performance.now(),!0)});var B=!0;function D(p){p!==z&&(z=p,p?(I=0,U=requestAnimationFrame(L)):cancelAnimationFrame(U))}document.addEventListener("visibilitychange",function(){D(!document.hidden&&B)}),typeof IntersectionObserver=="function"&&new IntersectionObserver(function(p){B=p[0].isIntersecting,D(!document.hidden&&B)}).observe(i)};Q()})();
