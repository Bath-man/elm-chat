import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Node HTTP/WebSocket server; production serves the same assets and API together.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000, proxy: { "/api": {
    target: process.env.API_ORIGIN ?? "http://localhost:8080", changeOrigin: false, ws: true
  } } }
});
