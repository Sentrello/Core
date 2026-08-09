import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // the SPA talks to the Hono API; same origin in production
    proxy: { "/api": "http://localhost:3000" },
  },
  build: { outDir: "dist" },
});
