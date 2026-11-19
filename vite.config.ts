import { defineConfig } from "vite";

// Relative base: a GitHub Pages project site is served under /<repo>/, not at the domain root.
export default defineConfig({ base: "./" });
