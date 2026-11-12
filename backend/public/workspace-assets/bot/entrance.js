/* Recreated from the observed x.ai home entrance, using native Web Animations.
   One timeline, no headline blur/scale/bounce and no inherited parent reveal. */
(() => {
  'use strict';
  const bootstrap = window.botEntrance;
  if (!document.documentElement.classList.contains('entrance-pending')) return;
  const headline = document.querySelector('.framer-1fnjtpa h1');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const box = headline?.getBoundingClientRect();
  // Refreshing a scrolled page must not replay an invisible introduction.
  if (!box || reduced.matches || scrollY > 40 || box.top >= innerHeight - 40 || box.bottom <= 40 ||
      typeof headline.animate !== 'function') {
    bootstrap?.recover();
    clearTimeout(bootstrap?.timeout);
    return;
  }

  const easing = 'cubic-bezier(.22, 1, .36, 1)';
  const running = new Set();
  // Before the first rendering tick the document timeline can still read zero.
  // Both clocks share a time origin; use the live clock to retain the full intro.
  const timelineStart = performance.now();
  let observer;
  function reveal(element, from, duration, delay, start = timelineStart) {
    if (!element) return;
    const animation = element.animate([
      from,
      { opacity: 1, transform: 'none' },
    ], { duration, delay, easing, fill: 'both' });
    animation.startTime = start;
    running.add(animation);
    // Underlying markup already contains the settled state. Release compositor layers.
    animation.onfinish = () => { animation.cancel(); running.delete(animation); };
  }

  headline.querySelectorAll(':scope > span').forEach((word, index) => {
    reveal(word, { opacity: 0, transform: 'translateY(45%) rotateX(-40deg)' },
      650, 100 + 55 * index);
  });
  reveal(document.querySelector('.framer-1oqa9v2'),
    { opacity: 0, transform: 'translateY(16px)' }, 380, 580);
  reveal(document.querySelector('.tovi-hero-action'),
    { opacity: 0, transform: 'translateY(12px)' }, 380, 700);
  reveal(document.querySelector('.framer-15yv6jr'), { opacity: 0 }, 1250, 760);

  // Fade the decorative field as one layer, including a canvas created later by site.js.
  reveal(document.querySelector('.framer-1pn4jri-container'), { opacity: 0 }, 1600, 760);

  const sections = [...document.querySelectorAll('main > .framer-18gp9wj ~ section')];
  const laterDelay = 1100;
  function revealSection(section) {
    const now = performance.now();
    const elapsed = now - timelineStart;
    reveal(section, { opacity: 0 }, 1000, Math.max(0, laterDelay - elapsed),
      now);
    section.classList.remove('entrance-waiting');
    observer?.unobserve(section);
  }
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) revealSection(entry.target); });
    });
  }
  sections.forEach(section => {
    const bounds = section.getBoundingClientRect();
    if (bounds.top < innerHeight && bounds.bottom > 0) revealSection(section);
    else if (observer) {
      section.classList.add('entrance-waiting');
      observer.observe(section);
    }
  });

  // All initial styles are now owned by animations or the section observer.
  document.documentElement.classList.remove('entrance-pending');
  clearTimeout(bootstrap?.timeout);

  function settle() {
    observer?.disconnect();
    running.forEach(animation => animation.cancel());
    running.clear();
    bootstrap?.recover();
  }

  reduced.addEventListener('change', event => {
    if (event.matches) {
      settle();
    }
  });
  // Back/forward cache restores the settled page rather than a frozen partial reveal.
  addEventListener('pageshow', event => {
    if (event.persisted) {
      settle();
    }
  });
  // Do not leave an invisible section focused during keyboard or anchor navigation.
  addEventListener('focusin', event => {
    const section = event.target.closest?.('.entrance-waiting');
    if (section) {
      section.classList.remove('entrance-waiting');
      observer?.unobserve(section);
    }
  });
  addEventListener('hashchange', settle);
})();
