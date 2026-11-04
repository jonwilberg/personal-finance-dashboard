import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the Vite server proxies API calls to the FastAPI backend (`uv run finance serve`).
// The backend uses a self-signed certificate for https://localhost, hence `secure: false`.
const backend = process.env.BACKEND_URL ?? "https://localhost:8765";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true, secure: false },
    },
  },
});
