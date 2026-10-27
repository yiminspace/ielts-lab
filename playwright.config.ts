import { defineConfig, devices } from "@playwright/test";
import net from "node:net";

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
const webPort = Number(process.env.IELTS_BROWSER_PORT || (await freePort()));
let apiPort = Number(process.env.IELTS_BROWSER_API_PORT || (await freePort()));
while (apiPort === webPort) apiPort = await freePort();
process.env.IELTS_BROWSER_PORT = String(webPort);
process.env.IELTS_BROWSER_API_PORT = String(apiPort);

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30000,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --force",
    url: `http://127.0.0.1:${webPort}`,
    env: { PORT: String(webPort), API_PORT: String(apiPort) },
    reuseExistingServer: false,
  },
});
