/* Responsive homepage illustration. One selected asset; no media fetch for reduced motion. */
(() => {
  const video = document.getElementById('product-demo');
  const toggle = document.getElementById('hero-playback');
  if (!video || !toggle) return;
  const poster = document.querySelector('.ff-hero-poster');
  const frame = video.parentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = matchMedia('(max-width: 809.98px)');
  const compact = matchMedia('(max-width: 359.98px)');
  let explicitPlay = false;
  let userPaused = false;
  const updateButton = () => {
    const paused = video.paused || reduced.matches && !explicitPlay;
    toggle.setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
    toggle.dataset.paused = String(paused);
  };
  const select = () => {
    const key = compact.matches ? 'compact' : mobile.matches ? 'mobile' : 'desktop';
    video.poster = video.dataset[`${key}Poster`];
    if (reduced.matches && !explicitPlay) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      frame.classList.remove('ff-hero-user-play');
      updateButton();
      return;
    }
    frame.classList.add('ff-hero-user-play');
    if (poster) poster.hidden = true;
    const src = video.dataset[`${key}Mp4`];
    if (video.getAttribute('src') !== src) {
      video.src = src;
      video.load();
    }
    if (!userPaused) video.play().catch(updateButton);
    updateButton();
  };
  toggle.addEventListener('click', () => {
    if (reduced.matches && !explicitPlay) {
      explicitPlay = true;
      userPaused = false;
      select();
    } else if (video.paused) {
      userPaused = false;
      video.play().catch(updateButton);
    } else {
      userPaused = true;
      video.pause();
    }
  });
  video.addEventListener('play', updateButton);
  video.addEventListener('pause', updateButton);
  video.addEventListener('error', () => {
    video.style.display = 'none';
    if (poster) {poster.hidden = false; poster.style.display = 'block';}
    toggle.hidden = true;
  });
  reduced.addEventListener('change', () => {
    explicitPlay = false;
    userPaused = false;
    if (poster) poster.hidden = false;
    select();
  });
  mobile.addEventListener('change', select);
  compact.addEventListener('change', select);
  select();
})();
