// Independent dithered wave renderer for the approved atmospheric footer.
// No React Bits Pro source, bundles, or shaders were used.
const vertex = `attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}`;
const fragment = `precision highp float;
uniform vec2 resolution;
uniform float time,scale,intensity,pixel;
uniform vec3 background,primary,secondary;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);
}
float field(vec2 p,float t){
  vec2 q=p;
  q+=vec2(sin(p.y*.77+t*.21),cos(p.x*.63-t*.16))*.78;
  q+=vec2(noise(p*.57+vec2(t*.045,-t*.035)),noise(p*.54+vec2(8.,t*.04)))*1.7;
  return q.x*.83+q.y*.32+sin(q.y*.88-t*.19)*1.35+sin(q.x*.56+q.y*.39+t*.14)*1.15;
}
float bayer(vec2 p){
  vec2 a=mod(floor(p),2.);vec2 b=mod(floor(p*.5),2.);vec2 c=mod(floor(p*.25),2.);
  float x=2.*a.x+3.*a.y-4.*a.x*a.y;
  float y=2.*b.x+3.*b.y-4.*b.x*b.y;
  float z=2.*c.x+3.*c.y-4.*c.x*c.y;
  return (x*16.+y*4.+z+.5)/64.;
}
void main(){
  vec2 samplePixel=floor(gl_FragCoord.xy/pixel);
  vec2 uv=(samplePixel*pixel+.5*pixel)/resolution;
  vec2 p=(uv-.5)*vec2(resolution.x/resolution.y,1.)*(24./max(scale,.5));
  float f=field(p,time);
  float wave=.5+.5*sin(f*2.55-time*.21);
  float amplitude=pow(wave,3.1/max(.25,intensity));
  float lighting=.63+.37*noise(p*.5+vec2(time*.06,3.));
  float value=clamp(amplitude*lighting*1.22-.09,0.,1.);
  float threshold=bayer(samplePixel);
  vec3 color=value<.50?mix(background,primary,step(threshold,value*2.)):mix(primary,secondary,step(threshold,(value-.5)*2.));
  gl_FragColor=vec4(color,1.);
}`;

function rgb(hex) {
  return [1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255);
}

export function mount(element, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  canvas.setAttribute('aria-hidden','true');
  element.append(canvas);
  const gl = canvas.getContext('webgl',{alpha:false,antialias:false,depth:false});
  if (!gl) {canvas.remove();throw new Error('WebGL is unavailable');}
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader,source);gl.compileShader(shader);
    if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  const vs = compile(gl.VERTEX_SHADER,vertex), fs = compile(gl.FRAGMENT_SHADER,fragment);
  const program = gl.createProgram();
  gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  const uniforms=Object.fromEntries(['resolution','time','scale','intensity','pixel','background','primary','secondary'].map(name=>[name,gl.getUniformLocation(program,name)]));
  const reduced=matchMedia('(prefers-reduced-motion:reduce)');
  const settings={speed:1,scale:4,intensity:2,downScale:.6,palette:'sumi',maxFPS:60,paused:false,...options};
  let elapsed=5,previous=0,raf=0,lastDraw=0,visible=true,destroyed=false;
  let layoutWidth=element.clientWidth,layoutHeight=element.clientHeight;
  function draw() {
    if (destroyed) return;
    const dpr=Math.min(2,devicePixelRatio||1);
    const width=Math.max(1,Math.round(layoutWidth*dpr)),height=Math.max(1,Math.round(layoutHeight*dpr));
    if (canvas.width!==width||canvas.height!==height) {canvas.width=width;canvas.height=height;gl.viewport(0,0,width,height);}
    const dark=document.documentElement.classList.contains('dark');
    const colors=settings.palette==='reference'?['#0a0a0a','#5227ff','#ffffff']:dark?['#111315','#3b6fd8','#c7ddff']:['#fafafa','#3b6fd8','#112b56'];
    gl.uniform2f(uniforms.resolution,width,height);
    gl.uniform1f(uniforms.time,elapsed);gl.uniform1f(uniforms.scale,settings.scale);
    gl.uniform1f(uniforms.intensity,settings.intensity);gl.uniform1f(uniforms.pixel,Math.max(1,settings.downScale*2)*dpr);
    ['background','primary','secondary'].forEach((key,index)=>gl.uniform3fv(uniforms[key],rgb(colors[index])));
    gl.drawArrays(gl.TRIANGLES,0,3);
  }
  function tick(now) {
    raf=0;
    if(destroyed||!visible||document.hidden||settings.paused||reduced.matches)return;
    const dt=previous?Math.min(.1,(now-previous)/1000):0;previous=now;elapsed+=dt*settings.speed;
    if(now-lastDraw>=1000/settings.maxFPS){draw();lastDraw=now;}
    raf=requestAnimationFrame(tick);
  }
  function schedule(){cancelAnimationFrame(raf);raf=0;previous=0;if(!destroyed&&visible&&!document.hidden&&!settings.paused&&!reduced.matches)raf=requestAnimationFrame(tick);else draw();}
  const resize=new ResizeObserver(entries=>{layoutWidth=entries[0].contentRect.width;layoutHeight=entries[0].contentRect.height;draw();});resize.observe(element);
  const intersection=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;schedule();});intersection.observe(element);
  const theme=new MutationObserver(draw);theme.observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  document.addEventListener('visibilitychange',schedule);reduced.addEventListener('change',schedule);
  draw();schedule();
  const dispose=()=>{destroyed=true;cancelAnimationFrame(raf);resize.disconnect();intersection.disconnect();theme.disconnect();document.removeEventListener('visibilitychange',schedule);reduced.removeEventListener('change',schedule);gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);canvas.remove();};
  dispose.update=values=>{Object.assign(settings,values);draw();schedule();};
  return dispose;
}
