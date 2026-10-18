import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 4317),
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:" + (process.env.API_PORT || 4318),
      "/media": "http://127.0.0.1:" + (process.env.API_PORT || 4318),
    },
  },
  build: { outDir: "dist" },
});
