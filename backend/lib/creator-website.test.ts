import test from "node:test";
import assert from "node:assert/strict";
import { isWebsiteOnly, readCampaignWebsite, websiteFromMessage } from "./creator/website";

test("website links can be supplied naturally", () => {
  assert.equal(websiteFromMessage("Our site is chatedu.io"), "https://chatedu.io");
  assert.equal(websiteFromMessage("See https://example.com/about."), "https://example.com/about");
  assert.equal(websiteFromMessage("We serve college students"), null);
  assert.equal(websiteFromMessage("Contact me at person@example.com"), null);
  assert.equal(websiteFromMessage("example.com?ref=demo"), "https://example.com?ref=demo");
  assert.equal(isWebsiteOnly("chatedu.io"), true);
  assert.equal(isWebsiteOnly("chatedu.io and focus on teachers"), false);
});

test("website reader rejects local hosts, credentials and non-HTTPS targets", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "https://127.0.0.1/",
    "https://169.254.169.254/",
    "https://localhost/",
    "https://user:password@example.com/",
    "https://example.com:8443/",
    "https://[::1]/",
  ]) {
    await assert.rejects(readCampaignWebsite(url));
  }
});

test("website icon selection prefers touch icons and stays on the website origin", async () => {
  const { websiteIconsFromHtml } = await import("./creator/website");
  const html = `<link href="/favicon.png" rel="icon"><link rel='apple-touch-icon' href='/touch.png?v=1&amp;x=2'>`;
  assert.equal(websiteIconsFromHtml(html, "https://example.com/about")[0], "https://example.com/touch.png?v=1&x=2");
  assert.equal(websiteIconsFromHtml(`<link rel="icon" href="https://elsewhere.example/icon.png">`, "https://example.com")[0], "https://example.com/favicon.ico");
  assert.equal(websiteIconsFromHtml(`<link rel="icon" href="http://example.com/a">`, "https://example.com")[0], "https://example.com/favicon.ico");
});

test("redirects upgrade HTTP before fetching, without allowing unsafe URLs", async () => {
  const { secureRedirect } = await import("./creator/website");
  assert.equal(secureRedirect("http://www.example.com/path", new URL("https://example.com")).href, "https://www.example.com/path");
  assert.equal(secureRedirect("/next", new URL("https://example.com/start")).href, "https://example.com/next");
  assert.equal(secureRedirect("http://127.0.0.1/", new URL("https://example.com")).href, "https://127.0.0.1/");
  assert.equal(secureRedirect("http://user:pass@example.com/", new URL("https://example.com")).protocol, "http:");
});
