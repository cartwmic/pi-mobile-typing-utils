#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const LIMIT_BYTES = 8 * 1024 * 1024;
const MEGABYTE = 1024 * 1024;

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
});

if (result.status !== 0) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  process.exit(result.status ?? 1);
}

const output = result.stdout.trim();
const [packManifest] = JSON.parse(output);
const files = Array.isArray(packManifest?.files) ? packManifest.files : [];
const totalBytes = files
  .filter((entry) => typeof entry.path === "string" && !entry.path.split("/").includes("node_modules"))
  .reduce((sum, entry) => sum + (typeof entry.size === "number" ? entry.size : 0), 0);

const totalMegabytes = totalBytes / MEGABYTE;

if (totalBytes > LIMIT_BYTES) {
  console.error(
    `Bundle size check failed: ${totalMegabytes.toFixed(2)} MB (${totalBytes} bytes) exceeds 8.00 MB (${LIMIT_BYTES} bytes).`,
  );
  process.exit(1);
}

console.log(`Bundle size check passed: ${totalMegabytes.toFixed(2)} MB (${totalBytes} bytes) <= 8.00 MB.`);
