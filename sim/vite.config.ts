import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS is required for the iPhone camera (tracker) and the laptop microphone (Grok Voice).
// If certs/lan.pem + certs/lan-key.pem exist (mkcert, trusted on the iPhone), use them; otherwise self-signed.
const certFile = resolve(__dirname, "certs/lan.pem");
const keyFile = resolve(__dirname, "certs/lan-key.pem");
const mkcert = existsSync(certFile) && existsSync(keyFile);

export default defineConfig({
  plugins: mkcert ? [] : [basicSsl()],
  server: {
    host: true,
    port: 5173,
    https: mkcert ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
      "/api": "http://127.0.0.1:8000",
      "/patches": "http://127.0.0.1:8000",
    },
  },
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, "index.html"), tracker: resolve(__dirname, "tracker.html") },
    },
    chunkSizeWarningLimit: 2000,
  },
});
