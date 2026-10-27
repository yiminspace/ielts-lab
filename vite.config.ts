import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: new URL("./apps/web", import.meta.url).pathname,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 4317),
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:" + (process.env.API_PORT || 4318),
        changeOrigin: false,
      },
      "/media": {
        target: "http://127.0.0.1:" + (process.env.API_PORT || 4318),
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: new URL("./dist", import.meta.url).pathname,
    emptyOutDir: true,
  },
});
