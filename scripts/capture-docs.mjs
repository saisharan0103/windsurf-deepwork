#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const outputRoot = path.resolve(process.argv[2] || path.join(os.tmpdir(), "deepwork-site-review-cdp"));
const browserCandidates = process.platform === "win32"
  ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ]
  : ["google-chrome", "chromium", "chromium-browser"];

const { existsSync } = await import("node:fs");
const browserPath = browserCandidates.find((candidate) => process.platform !== "win32" || existsSync(candidate));
if (!browserPath) throw new Error("Chrome or Edge was not found.");

await mkdir(outputRoot, { recursive: true });
const profileRoot = path.join(outputRoot, `profile-${process.pid}-${Date.now()}`);
const port = 9300 + Math.floor(Math.random() * 400);
const browser = spawn(browserPath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--allow-file-access-from-files",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileRoot}`,
  "about:blank"
], { stdio: "ignore", windowsHide: true });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const endpoint = `http://127.0.0.1:${port}`;

try {
  let version;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        version = await response.json();
        break;
      }
    } catch {
      // Browser startup is still in progress.
    }
    await delay(100);
  }
  if (!version) throw new Error("Browser debugging endpoint did not start.");

  const pageResponse = await fetch(`${endpoint}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
  if (!pageResponse.ok) throw new Error(`Could not create browser page: ${pageResponse.status}`);
  const page = await pageResponse.json();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let messageId = 0;
  const pending = new Map();
  const browserExceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      browserExceptions.push(message.params?.exceptionDetails?.text || "Unknown browser exception");
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++messageId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send("Page.enable");
  await send("Runtime.enable");
  const siteUrl = pathToFileURL(path.join(root, "docs", "index.html")).href;

  async function navigateAndSettle() {
    await send("Page.navigate", { url: siteUrl });
    await delay(900);
    await send("Runtime.evaluate", {
      expression: "document.fonts ? document.fonts.ready.then(() => true) : true",
      awaitPromise: true,
      returnByValue: true
    });
    await delay(250);
  }

  async function capture(name) {
    const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const target = path.join(outputRoot, name);
    await writeFile(target, Buffer.from(result.data, "base64"));
    return target;
  }

  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await navigateAndSettle();
  const desktopChecks = await send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelector('[data-route-tab="control"]').click();
      const routeWorks = !document.querySelector('[data-route-panel="control"]').hidden && document.querySelector('[data-route-panel="notify"]').hidden;
      document.querySelector('[data-route-tab="notify"]').click();
      const search = document.getElementById('docs-search');
      search.value = 'Heroku';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const searchWorks = document.getElementById('search-status').textContent.includes('1 support topic');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return { routeWorks, searchWorks, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    })()`,
    returnByValue: true
  });
  if (!desktopChecks.result.value.routeWorks || !desktopChecks.result.value.searchWorks) {
    throw new Error(`Desktop interaction check failed: ${JSON.stringify(desktopChecks.result.value)}`);
  }
  if (desktopChecks.result.value.scrollWidth > desktopChecks.result.value.width) {
    throw new Error(`Desktop horizontal overflow: ${JSON.stringify(desktopChecks.result.value)}`);
  }
  const desktopHero = await capture("desktop-hero.png");

  await send("Runtime.evaluate", {
    expression: "document.documentElement.style.scrollBehavior='auto'; document.getElementById('whatsapp').scrollIntoView({block:'start'}); window.scrollBy(0, -72)"
  });
  await delay(250);
  const desktopWhatsApp = await capture("desktop-whatsapp.png");

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await navigateAndSettle();
  const mobileMetrics = await send("Runtime.evaluate", {
    expression: "({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, menuVisible: getComputedStyle(document.getElementById('menu-button')).display !== 'none' })",
    returnByValue: true
  });
  if (!mobileMetrics.result.value.menuVisible || mobileMetrics.result.value.scrollWidth > mobileMetrics.result.value.width) {
    throw new Error(`Mobile layout check failed: ${JSON.stringify(mobileMetrics.result.value)}`);
  }
  const mobileHero = await capture("mobile-hero.png");

  if (browserExceptions.length) {
    throw new Error(`Browser exceptions: ${browserExceptions.join("; ")}`);
  }

  socket.close();
  console.log(JSON.stringify({ desktopHero, desktopWhatsApp, mobileHero, desktop: desktopChecks.result.value, mobile: mobileMetrics.result.value }, null, 2));
} finally {
  browser.kill();
}
