// Original analytic silhouettes. Common angular samples keep point correspondence
// through every morph; the spline changes contour, never swaps or crossfades icons.
export const COUNT = 96;
const TAU = Math.PI * 2;
const clamp = x => Math.max(0, Math.min(1, x));
export const ease = x => {
  x = clamp(x);
  // A short acceleration into a long, monotonic settle. No spring overshoot.
  return 1 - (1 + 8 * x) * Math.exp(-8 * x);
};
// Normalize the easing to arrive exactly, without a final-frame discontinuity.
export const settle = x => ease(x) / ease(1);
const definitions = {
  round: a => 41,
  pebble: a => 41 * (1 + .065 * Math.cos(a - .6) + .09 * Math.sin(2 * a + .65)),
  square: a => 36 / Math.pow(Math.abs(Math.cos(a)) ** 4 + Math.abs(Math.sin(a)) ** 4, .25),
  triangle: a => {
    const period = TAU / 3;
    const angle = ((a + Math.PI / 2 + period / 2) % period + period) % period - period / 2;
    return 28 / Math.cos(Math.PI / 3 - Math.abs(angle));
  },
};
function profile(fn, rounded = false) {
  let radii = Array.from({length:COUNT}, (_, i) => fn(i / COUNT * TAU));
  if (rounded) for (let pass = 0; pass < 10; pass++) {
    radii = radii.map((r, i) => (radii[(i+COUNT-1)%COUNT] + 2*r + radii[(i+1)%COUNT]) / 4);
  }
  // Equal filled area prevents an unwanted 'inflating' sensation between poses.
  const area = radii.reduce((sum, r, i) => sum + r*radii[(i+1)%COUNT]*Math.sin(TAU/COUNT)/2, 0);
  const scale = Math.sqrt(Math.PI * 40 ** 2 / area);
  return radii.map(r => r * scale);
}
export const profiles = Object.fromEntries(Object.entries(definitions).map(([name, fn]) => [name, profile(fn, name === 'triangle')]));
// Preserve the first study's actual four Bezier segments, rather than substitute
// another analytic pebble. Sample rays through that outline for the morph rig.
const originalSegments = [
  [[64,17],[88,17],[107,32],[109,55]],
  [[109,55],[112,80],[96,105],[70,109]],
  [[70,109],[45,113],[22,99],[19,76]],
  [[19,76],[15,51],[36,18],[64,17]],
];
const outline = originalSegments.flatMap(segment => Array.from({length:256},(_,i)=>{
  const t=i/256,u=1-t;
  return [0,1].map(axis=>u**3*segment[0][axis]+3*u*u*t*segment[1][axis]+3*u*t*t*segment[2][axis]+t**3*segment[3][axis]-64);
}));
const cross = (a,b) => a[0]*b[1]-a[1]*b[0];
profiles.original = profile(angle => {
  const direction=[Math.cos(angle),Math.sin(angle)];
  let nearest=Infinity;
  outline.forEach((p,i)=>{
    const q=outline[(i+1)%outline.length],edge=[q[0]-p[0],q[1]-p[1]];
    const denominator=cross(direction,edge);
    if(Math.abs(denominator)<1e-10)return;
    const radius=cross(p,edge)/denominator,along=cross(p,direction)/denominator;
    if(radius>0 && along>=0 && along<=1)nearest=Math.min(nearest,radius);
  });
  return nearest;
});
export const blend = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export function contour(radii) {
  const points = radii.map((r, i) => [64 + r * Math.cos(i / COUNT * TAU), 64 + r * Math.sin(i / COUNT * TAU)]);
  const n = points.length, f = v => v.toFixed(3);
  let d = `M${points[0].map(f).join(' ')}`;
  for(let i=0;i<n;i++) {
    const p0=points[(i+n-1)%n],p1=points[i],p2=points[(i+1)%n],p3=points[(i+2)%n];
    d += `C${f(p1[0]+(p2[0]-p0[0])/6)} ${f(p1[1]+(p2[1]-p0[1])/6)} ${f(p2[0]-(p3[0]-p1[0])/6)} ${f(p2[1]-(p3[1]-p1[1])/6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d+'Z';
}
