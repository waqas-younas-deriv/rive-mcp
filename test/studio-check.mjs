// Studio の実動作検証: 起動 → 実ブラウザで開いて描画確認 → 再ビルドAPI確認
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { studioFetch, rememberStudio } from "./studio-client.mjs";
process.env.RIVE_MCP_WORKSPACE = process.cwd();
const { startStudio, stopStudio } = await import("../dist/studio.js");
import { chromium } from "playwright-core";

// シーンJSON（スタジオの編集パネル用）
const scene = {
  artboard: { name: "StudioDemo", width: 400, height: 300 },
  backgroundColor: "#1a1a2e",
  shapes: [
    { id: "orb", type: "ellipse", x: 200, y: 150, width: 90, height: 90,
      fill: { gradient: { stops: [{ color: "#00d9ff" }, { color: "#0066ff" }] } } },
  ],
  animations: [
    { name: "pulse", duration: 60, loop: "loop", tracks: [
      { target: "orb", property: "scaleX", keyframes: [
        { frame: 0, value: 1 }, { frame: 30, value: 1.4, easing: "ease-in-out" }, { frame: 60, value: 1 } ] } ] },
  ],
  stateMachine: {
    name: "SM", inputs: [{ name: "speed", type: "number", initial: 0 }, { name: "tap", type: "trigger" }],
    states: [{ name: "s", animation: "pulse" }], transitions: [{ from: "entry", to: "s" }],
    listeners: [{ target: "orb", type: "click", actions: [{ input: "tap" }] }],
  },
};
writeFileSync("samples/studio-scene.json", JSON.stringify(scene, null, 2));

// 初期rivをビルド
const { createRiv } = await import("../dist/rivWriter.js");
writeFileSync("samples/studio-demo.riv", Buffer.from(createRiv(scene).bytes));

const handle = await startStudio({
  rivPath: "samples/studio-demo.riv",
  scenePath: "samples/studio-scene.json",
  port: 8791,
});
rememberStudio(handle.url);
console.log("studio at", new URL(handle.url).origin);

// 実ブラウザ検証
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  ...(process.env.RIVE_MCP_CHROME ? { executablePath: process.env.RIVE_MCP_CHROME } : { channel: "chrome" }) });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(handle.url);
await page.waitForTimeout(2500);
const status = await page.textContent("#status");
console.log("status:", status);
const inputCount = await page.locator("#inputs .row").count();
console.log("input controls:", inputCount);
await page.screenshot({ path: "samples/studio-screenshot.png" });

// 再ビルドAPI: 色を変えて反映されるか
const modified = { ...scene };
modified.shapes = [{ ...scene.shapes[0], fill: { color: "#e94560" } }];
const res = await studioFetch("http://127.0.0.1:8791/rebuild", { method: "POST", body: JSON.stringify(modified) });
console.log("rebuild:", JSON.stringify(await res.json()));
await page.waitForTimeout(1500);
await page.screenshot({ path: "samples/studio-after-rebuild.png" });

await browser.close();
stopStudio();
console.log("done");
