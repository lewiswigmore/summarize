import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { runDaemonServer } from "../../../src/daemon/server.js";
import {
  BLOCKED_ENV_KEYS,
  DAEMON_PORT,
  DEFAULT_DAEMON_TOKEN,
  createSampleVideo,
  hasFfmpeg,
  isPortInUse,
  readDaemonToken,
  startDaemonSlidesRun,
  waitForSlidesSnapshot,
} from "./helpers/daemon-fixtures";
import {
  activateTabByUrl,
  assertNoErrors,
  buildUiState,
  closeExtension,
  getActiveTabId,
  getBrowserFromProject,
  getOpenPickerList,
  getSettings,
  injectContentScript,
  launchExtension,
  maybeBringToFront,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  waitForActiveTabUrl,
  waitForPanelPort,
} from "./helpers/extension-harness";

test("sidepanel extracts slides from local video via daemon", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(180_000);

  if (testInfo.project.name === "firefox") {
    test.skip(true, "Slides E2E is only validated in Chromium.");
  }
  if (!hasFfmpeg()) {
    test.skip(true, "ffmpeg is required for slide extraction.");
  }
  if (await isPortInUse(DAEMON_PORT)) {
    const token = readDaemonToken();
    if (!token) {
      test.skip(
        true,
        `Port ${DAEMON_PORT} is in use, but daemon token is missing. Set SUMMARIZE_DAEMON_TOKEN or ensure ~/.summarize/daemon.json exists.`,
      );
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "summarize-slides-e2e-"));
  const videoPath = path.join(tmpDir, "sample.mp4");
  const vttPath = path.join(tmpDir, "sample.vtt");
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Slides Test</title>
  </head>
  <body>
    <h1>Slides Test</h1>
    <p>Local video with captions for transcript extraction.</p>
    <video controls width="640" height="360" preload="metadata">
      <source src="/sample.mp4" type="video/mp4" />
      <track kind="captions" src="/sample.vtt" srclang="en" label="English" default />
    </video>
  </body>
</html>`;
  const vtt = [
    "WEBVTT",
    "",
    "00:00.000 --> 00:02.000",
    "Intro slide.",
    "",
    "00:02.000 --> 00:04.000",
    "Second slide.",
    "",
    "00:04.000 --> 00:06.000",
    "Third slide.",
    "",
  ].join("\n");

  createSampleVideo(videoPath);
  fs.writeFileSync(vttPath, vtt, "utf8");

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const body = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/sample.vtt") {
      const body = Buffer.from(vtt, "utf8");
      res.writeHead(200, {
        "content-type": "text/vtt; charset=utf-8",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/sample.mp4") {
      const body = fs.readFileSync(videoPath);
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  let serverUrl = "";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve local server port"));
        return;
      }
      serverUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  const portBusy = await isPortInUse(DAEMON_PORT);
  const externalToken = portBusy ? readDaemonToken() : null;
  const token = externalToken ?? DEFAULT_DAEMON_TOKEN;
  const homeDir = portBusy ? null : fs.mkdtempSync(path.join(os.tmpdir(), "summarize-daemon-e2e-"));
  const abortController = portBusy ? null : new AbortController();
  let daemonPromise: Promise<void> | null = null;

  if (!portBusy) {
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const env = {
      ...process.env,
      HOME: homeDir ?? os.homedir(),
      USERPROFILE: homeDir ?? os.homedir(),
      TESSERACT_PATH: "/nonexistent",
    };
    for (const key of BLOCKED_ENV_KEYS) {
      delete env[key];
    }

    daemonPromise = runDaemonServer({
      env,
      fetchImpl: fetch,
      config: { token, port: DAEMON_PORT, version: 1, installedAt: new Date().toISOString() },
      port: DAEMON_PORT,
      signal: abortController?.signal,
      onListening: () => resolveReady?.(),
    });
    await ready;
  }

  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token,
      autoSummarize: false,
      slidesEnabled: false,
      slidesParallel: false,
    });

    const contentPage = await harness.context.newPage();
    await contentPage.goto(`${serverUrl}/index.html`, { waitUntil: "domcontentloaded" });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, serverUrl);
    await waitForActiveTabUrl(harness, serverUrl);
    await injectContentScript(harness, "content-scripts/extract.js", serverUrl);
    const activeTabId = await getActiveTabId(harness);

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: activeTabId, url: `${serverUrl}/index.html`, title: "Slides Test" },
        media: { hasVideo: true, hasAudio: false, hasCaptions: true },
        stats: { pageWords: 24, videoDurationSeconds: 6 },
        settings: { autoSummarize: false, slidesEnabled: false, slidesParallel: false },
        status: "",
      }),
    });

    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, serverUrl);
    await waitForActiveTabUrl(harness, serverUrl);

    const summarizeButton = page.locator(".summarizeButton");
    await expect(summarizeButton).toBeVisible();
    await summarizeButton.focus();
    await summarizeButton.press("ArrowDown");
    const pickerList = getOpenPickerList(page);
    await expect(pickerList.getByText("Video + Slides", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await pickerList.getByText("Video + Slides", { exact: true }).click();
    await expect
      .poll(async () => {
        const settings = await getSettings(harness);
        return settings.slidesEnabled === true;
      })
      .toBe(true);
    await expect(summarizeButton).toBeEnabled();
    await summarizeButton.click();

    const runId = await startDaemonSlidesRun(`${serverUrl}/index.html`, token);
    await waitForSlidesSnapshot(runId, token);
    await sendBgMessage(harness, {
      type: "slides:run",
      ok: true,
      runId,
      url: `${serverUrl}/index.html`,
    });

    const img = page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage");
    await expect
      .poll(
        async () => {
          const count = await img.count();
          if (count === 0) return false;
          const ready = await img.first().evaluate((node) => node.dataset.loaded === "true");
          return ready;
        },
        { timeout: 120_000 },
      )
      .toBe(true);

    assertNoErrors(harness);
  } finally {
    if (abortController && daemonPromise) {
      abortController.abort();
      await daemonPromise;
    }
    await closeExtension(harness.context, harness.userDataDir);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
