import {mount} from './footer-wave.js';

(() => {
  const host=document.querySelector('.ff-atmospheric-footer');
  const element=host?.querySelector('.ff-footer-wave-mount');
  const button=host?.querySelector('.ff-footer-wave-pause');
  if(!element||!button)return;
  const reduced=matchMedia('(prefers-reduced-motion:reduce)');
  const pauseIcon='<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>';
  const playIcon='<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.5v9l7-4.5z"/></svg>';
  let renderer,observer,paused=false;
  function sync(){
    button.hidden=!renderer||reduced.matches;
    button.setAttribute('aria-label',paused?'Play footer animation':'Pause footer animation');
    button.innerHTML=paused?playIcon:pauseIcon;
  }
  function initialize(){
    if(renderer)return;
    observer?.disconnect();
    try{renderer=mount(element,{palette:'sumi',speed:.55,scale:6,intensity:1.5,paused});}
    catch{element.classList.add('ff-footer-wave-fallback');}
    sync();
  }
  function observe(){
    if(typeof IntersectionObserver==='undefined'){initialize();return;}
    observer=new IntersectionObserver(entries=>{if(entries[0].isIntersecting)initialize();},{rootMargin:'600px 0px'});
    observer.observe(host);
  }
  button.addEventListener('click',()=>{paused=!paused;renderer?.update({paused});sync();});
  reduced.addEventListener('change',sync);
  addEventListener('pagehide',()=>{observer?.disconnect();renderer?.();renderer=undefined;});
  addEventListener('pageshow',event=>{if(event.persisted)observe();});
  observe();
})();
