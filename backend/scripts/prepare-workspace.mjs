import { access } from "node:fs/promises";

// The selected landing and its runtime assets live with the application.
for (const file of ["landing.html", "fonts/Manrope-Latin-Variable.woff2", "bot/", "gallery/assets/", "gallery/sume-landing-demo.html", "sume-landing/story.css", "sume-landing/story.js"]) {
  await access(new URL(`../public/workspace-assets/${file}`, import.meta.url));
}
