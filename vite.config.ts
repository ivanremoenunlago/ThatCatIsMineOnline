import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "imagenes",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
