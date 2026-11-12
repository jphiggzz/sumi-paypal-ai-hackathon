import {profiles, blend, contour, settle} from './shapes.mjs';
import {sampleGlance} from './glance.mjs';
const path = document.querySelector('#silhouette');
const eyes = [document.querySelector('#left'), document.querySelector('#right')];
const svg = document.querySelector('.stage svg');
const pause = document.querySelector('#pause');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const buttons = [...document.querySelectorAll('[data-state]')];
const order = ['original', 'round', 'pebble', 'square', 'triangle', 'pebble'];
const poses = {
  original: [0, -2, 0, 12.5, 0],
  round: [0, -2, -12, 10, -16],
  pebble: [3, -1, -8, 10, -12],
  square: [-3, 0, -10, 10, -13],
  triangle: [0, 3, -5, 9, -9],
};
let mode = 'gesture', current = 'original', index = 0;
let gestureStart=0;
let clock = 0, changed = -2, deadline = 2.1, last = null, frame = null;
let paused = reduced.matches;
let shown = {radii:profiles.original, face:poses.original};
let origin = shown;
const DURATION = .72;
const clamp = x => Math.max(0,Math.min(1,x));
const pointer = {active:false, x:0, y:0};
const look = {x:0, y:0, weight:0};
function blink(age, duration) {
  if(age<0 || age>duration) return 1;
  const t=age/duration;
  // Fast close, a tiny hold, then a more relaxed opening.
  if(t<.28) return 1-settle(t/.28);
  if(t<.4) return 0;
  return settle((t-.4)/.6);
}
function sample() {
  const age=clock-changed;
  const bodyT=settle(clamp(age/DURATION));
  const faceT=settle(clamp((age-.065)/.57));
  return {radii:blend(origin.radii,profiles[current],bodyT),face:blend(origin.face,poses[current],faceT)};
}
function paint() {
  shown=sample();
  path.setAttribute('d',contour(shown.radii));
  const [gx,gy,tilt,gap,eyeY]=shown.face;
  const age=clock-changed;
  const transitionBlink=blink(age,.22);
  const idleBlink=blink((clock+1.8)%5.9,.18);
  const open = paused ? 1 : Math.min(transitionBlink,idleBlink);
  // A single authored glance during each hold; no perpetual sine-wave movement.
  const glance = mode!=='gesture' && !paused ? settle(clamp((age-1.1)/.28))*(1-settle(clamp((age-1.9)/.4)))*(1-look.weight) : 0;
  const gesture=mode==='gesture' ? sampleGlance(clock-gestureStart) : {x:0,y:0,tilt:0};
  eyes.forEach((eye,i)=>{
    const x=64+gx+(i ? gap : -gap)+glance*1.5+look.x*look.weight+gesture.x;
    const y=64+eyeY+gy+(i ? -1 : 1)+look.y*look.weight+gesture.y;
    const width=i ? 7.8 : 9.5;
    const height=Math.max(1.5,19*open);
    eye.setAttribute('x',-width/2);eye.setAttribute('y',-height/2);
    eye.setAttribute('width',width);eye.setAttribute('height',height);
    eye.setAttribute('rx',Math.min(width,height)/2);
    eye.setAttribute('transform',`translate(${x} ${y}) rotate(${tilt+gesture.tilt})`);
  });
  svg.setAttribute('aria-label',`bot character: ${current}`);
  svg.dataset.shape=current;
}
function change(next) {
  // Interruptions start from the exact displayed contour, including a half morph.
  origin=shown;current=next;changed=clock;
  if(paused) {origin={radii:profiles[next],face:poses[next]};changed=clock-2;}
  paint();
}
function sync() {
  buttons.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.state===mode)));
  pause.textContent=paused?'Play':'Pause';pause.setAttribute('aria-pressed',String(paused));
}
function tick(now) {
  frame=null;
  if(paused || document.hidden) {last=null;return;}
  const dt=last===null ? 0 : Math.min((now-last)/1000,.05);
  clock+=dt;
  last=now;
  if(mode==='loop' && clock>=deadline) {
    index=(index+1)%order.length;change(order[index]);
    // Vary the hold, not the morph speed. Each shape has time to resolve.
    deadline=clock+[2.65,2.9,2.45,3.1,2.7,2.8][index];
  }
  // Eye direction follows slowly and only regains authority after the contour
  // settles. Fade the influence itself so entering/leaving a morph cannot snap.
  const follow=1-Math.exp(-8*dt);
  look.x+=(pointer.x-look.x)*follow;
  look.y+=(pointer.y-look.y)*follow;
  const tracking=mode!=='gesture' && pointer.active && clock-changed>DURATION;
  look.weight+=((tracking ? 1 : 0)-look.weight)*(1-Math.exp(-(tracking ? 5 : 18)*dt));
  paint();frame=requestAnimationFrame(tick);
}
function run() {if(frame===null && !paused && !document.hidden)frame=requestAnimationFrame(tick);}
document.addEventListener('pointermove',event=>{
  if(event.pointerType!=='mouse'){pointer.active=false;return;}
  const bounds=svg.getBoundingClientRect();
  if(!bounds.width || !bounds.height)return;
  pointer.active=true;
  // Maximum excursion: two viewBox units horizontally, 1.4 vertically.
  pointer.x=(clamp((event.clientX-bounds.left)/bounds.width)*2-1)*2;
  pointer.y=(clamp((event.clientY-bounds.top)/bounds.height)*2-1)*1.4;
});
document.addEventListener('pointerleave',()=>{pointer.active=false;});
window.addEventListener('blur',()=>{pointer.active=false;});
buttons.forEach(button=>button.addEventListener('click',()=>{
  mode=button.dataset.state;
  if(mode==='gesture') {gestureStart=clock;look.weight=0;change('original');}
  else if(mode==='loop') {index=0;change(order[0]);deadline=clock+2.5;}
  else change(mode);
  sync();run();
}));
pause.addEventListener('click',()=>{
  paused=!paused;last=null;
  // Preserve the displayed frame when pausing, resume from the same clock.
  sync();run();
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){pointer.active=false;if(frame!==null){cancelAnimationFrame(frame);frame=null;last=null;}}
  else run();
});
reduced.addEventListener('change',()=>{
  paused=reduced.matches;last=null;
  if(paused){origin={radii:profiles[current],face:poses[current]};changed=clock-2;paint();}
  sync();run();
});
sync();paint();run();
