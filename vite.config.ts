import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev-server port and must not have its Rust
// rebuilds trigger page reloads.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    // Monaco is one ~3 MB chunk, loaded lazily from disk; size isn't a concern.
    chunkSizeWarningLimit: 4096,
  },
});
