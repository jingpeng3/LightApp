import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = `http://127.0.0.1:${process.env.DT_PORT ?? "8654"}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../src/dt/static", emptyOutDir: true },
  server: { proxy: { "/api": { target: api, ws: true } } },
});
