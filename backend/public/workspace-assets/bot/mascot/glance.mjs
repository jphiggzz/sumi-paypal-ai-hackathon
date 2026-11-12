const clamp = value => Math.max(0,Math.min(1,value));
const ease = value => {const t=clamp(value);return clamp(t*t*t*(t*(t*6-15)+10));};
// The first 1.75 seconds are the scene gesture; the remaining time is a quiet
// hold and reset for repeated review in the mascot playground.
export function sampleGlance(seconds) {
  const t=((seconds%3.4)+3.4)%3.4;
  const right=ease((t-.12)/.58);
  const up=ease((t-.88)/.72);
  const reset=ease((t-2.15)/.9);
  return {
    x:4*right*(1-up)*(1-reset),
    y:-4*up*(1-reset),
    tilt:-2*right*(1-up)*(1-reset),
  };
}
