(() => {
  const video = document.querySelector('#roster-hero');
  if (!video) return;
  const mediaPrefix = video.dataset.mediaPrefix || 'tovi-hero-v2';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let activeLayout = '', inView = false;
  video.loop = true;
  video.defaultPlaybackRate = video.playbackRate = 1;
  function maybePlay() {
    if (inView && !document.hidden && !reduced.matches) {
      select(true);
      video.play().catch(() => {});
    } else video.pause();
  }
  function select(load) {
    const next = innerWidth < 360 ? 'compact' : innerWidth < 810 ? 'mobile' : 'desktop';
    if (next === activeLayout && (!load || video.getAttribute('src'))) return;
    const previousTime = video.currentTime || 0;
    video.pause();
    activeLayout = next;
    video.poster = '/media/' + mediaPrefix + '-' + next + '-poster.png';
    if (load) {
      video.preload = 'metadata';
      video.src = '/media/' + mediaPrefix + '-' + next + '.mp4';
      video.addEventListener('loadedmetadata', () => {
        video.playbackRate = 1;
        video.currentTime = Math.min(previousTime, video.duration || previousTime);
        maybePlay();
      }, {once: true});
      video.load();
    } else video.removeAttribute('src');
  }
  new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    maybePlay();
  }, {threshold:.2}).observe(video.parentElement);
  document.addEventListener('visibilitychange', maybePlay);
  reduced.addEventListener('change', maybePlay);
  addEventListener('resize', () => select(Boolean(video.getAttribute('src'))));
  select(false);
})();

// Keep the film's opaque background close to the animated card, so smaller
// scenes reveal the page backdrop instead of filling the maximum scene frame.
(() => {
  const video = document.querySelector('#roster-hero');
  if (!video) return;
  const times = [0, 3.5, 7, 10.5, 14, 17];
  // Dimensions and spring match HeroMotion.tsx / HeroStoryboard.tsx (v6).
  const desktop = [[640,148],[830,465],[520,420],[700,500],[500,460],[400,300]];
  const mobileHeights = [184,580,450,650,510,310];
  const omega = Math.sqrt(210 / .85);
  function update(time = video.currentTime) {
    if (!video.hasAttribute('src')) time = 6.2; // Installed poster frame.
    const compact = innerWidth < 360, mobile = innerWidth < 810;
    const width = mobile ? compact ? 320 : 390 : 1440;
    const height = mobile ? compact ? 840 : 760 : 810;
    const scale = mobile ? 1 : 1.35;
    const sizes = desktop.map(([w,h],i) => mobile
      ? [width - 32, mobileHeights[i] + (compact && i === 3 ? 55 : 0)]
      : [w * scale, h * scale]);
    const shape = [...sizes[0]];
    for (let i = 1; i < sizes.length; i++) {
      const elapsed = Math.max(0, time - times[i]);
      // The render's damping ratio is >= 1; Remotion uses this critical spring.
      const ease = 1 - (1 + omega * elapsed) * Math.exp(-omega * elapsed);
      shape[0] += (sizes[i][0] - sizes[i-1][0]) * ease;
      shape[1] += (sizes[i][1] - sizes[i-1][1]) * ease;
    }
    const padding = document.documentElement.classList.contains('dark') ? 0 : mobile ? 14 : 30;
    const x = Math.max(0, (width - shape[0]) / 2 - padding) / width * 100;
    const y = Math.max(0, (height - shape[1]) / 2 - padding) / height * 100;
    const radius = ((mobile ? 28 : 36) + padding) * video.clientWidth / width;
    video.style.clipPath = `inset(${y}% ${x}% round ${radius}px)`;
  }
  ['loadedmetadata','seeked','timeupdate','pause','emptied'].forEach(event =>
    video.addEventListener(event, () => update()));
  addEventListener('resize', () => update());
  new MutationObserver(() => update()).observe(document.documentElement, {attributes:true, attributeFilter:['class']});
  if ('requestVideoFrameCallback' in video) {
    const frame = (_, metadata) => {
      update(metadata.mediaTime);
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
  }
  update();
})();
