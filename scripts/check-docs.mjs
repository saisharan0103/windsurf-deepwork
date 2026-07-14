#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const docsRoot = path.join(root, "docs");
const html = await readFile(path.join(docsRoot, "index.html"), "utf8");

const failures = [];
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length) failures.push(`duplicate IDs: ${[...new Set(duplicateIds)].join(", ")}`);

for (const match of html.matchAll(/href="#([^"]+)"/g)) {
  if (!ids.includes(match[1])) failures.push(`missing anchor target: #${match[1]}`);
}

const requiredPatterns = [
  [/<meta\s+name="viewport"/i, "viewport meta"],
  [/<a\s+class="skip-link"\s+href="#main-content"/i, "skip link"],
  [/<main\s+id="main-content"/i, "main landmark"],
  [/prefers-reduced-motion/, "reduced-motion support"],
  [/WhatsApp Cloud API/, "WhatsApp integration boundary"],
  [/This repository does not include a WhatsApp bot/i, "WhatsApp non-claim"],
  [/deepwork\.final_gate/, "final gate documentation"],
  [/rel="noopener noreferrer"/, "safe external-link relation"]
];

for (const [pattern, label] of requiredPatterns) {
  if (!pattern.test(html) && !pattern.test(await readFile(path.join(docsRoot, "styles.css"), "utf8"))) {
    failures.push(`missing ${label}`);
  }
}

for (const file of ["styles.css", "app.js", "favicon.svg", ".nojekyll"]) {
  try {
    await readFile(path.join(docsRoot, file));
  } catch {
    failures.push(`missing docs/${file}`);
  }
}

if (/href=""|href="#"/.test(html)) failures.push("empty link target found");
if (/target="_blank"(?![^>]*rel="noopener noreferrer")/.test(html)) {
  failures.push("external target=_blank link missing rel=noopener noreferrer");
}
if (/\b(TODO|FIXME|YOUR_[A-Z_]+|<public-repository-url>)\b/.test(html)) {
  failures.push("placeholder text found");
}

if (failures.length) {
  console.error(`Documentation checks failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation checks passed (${ids.length} IDs and all local anchors resolved).`);
}
