(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function syncStep(time) {
    const active=time>=17?3:time>=11?2:time>=5?1:0;
    document.querySelectorAll('.tovi-step-title').forEach(title=>{
      if(Number(title.dataset.storyStep)===active) title.setAttribute('aria-current','step');
      else title.removeAttribute('aria-current');
    });
  }
  syncStep(0);
  document.querySelectorAll('.tovi-deal-video').forEach(video => {
    const syncCurrentStep=()=>{if(video.getBoundingClientRect().width>0)syncStep(video.currentTime);};
    ['timeupdate','seeked','loadedmetadata'].forEach(event=>video.addEventListener(event,syncCurrentStep));
    const button = video.parentElement.querySelector('button');
    let inView=false, userPaused=false, active='';
    const sync=()=>{button.textContent=video.paused?'Play':'Pause';button.setAttribute('aria-label',button.textContent+' deal animation');};
    function select(load){
      const layout=innerWidth<810?'mobile':'desktop';
      if(active===layout&&(!load||video.getAttribute('src')))return;
      active=layout;const time=video.currentTime||0;
      video.poster='/media/tovi-story-v2-'+layout+'-poster.png';
      if(load){video.src='/media/tovi-story-v2-'+layout+'.mp4';video.addEventListener('loadedmetadata',()=>{video.currentTime=Math.min(time,video.duration);if(inView&&!document.hidden&&!userPaused&&!reduced.matches)video.play().catch(sync);},{once:true});}
    }
    function update(){if(inView&&!document.hidden&&!userPaused&&!reduced.matches){select(true);video.play().catch(sync);}else video.pause();}
    button.addEventListener('click',()=>{if(video.paused){userPaused=false;select(true);video.play().catch(sync);}else{userPaused=true;video.pause();}sync();});
    video.addEventListener('play',sync);video.addEventListener('pause',sync);
    new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;update();},{threshold:.2}).observe(video);
    document.addEventListener('visibilitychange',update);
    reduced.addEventListener('change',()=>{if(reduced.matches){userPaused=true;video.pause();}else{userPaused=false;update();}});
    addEventListener('resize',()=>select(Boolean(video.getAttribute('src'))));
    select(false);sync();
  });
})();
