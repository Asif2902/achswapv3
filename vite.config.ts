import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  envDir: path.resolve(__dirname),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
      "@assets": path.resolve(__dirname, "attached_assets"),
    },
  },
  root: path.resolve(__dirname, "client"),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-ethers": ["ethers"],
          "vendor-rainbowkit": ["@rainbow-me/rainbowkit"],
          "vendor-react-query": ["@tanstack/react-query"],
          "vendor-wagmi": ["wagmi"],
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
  },
});
