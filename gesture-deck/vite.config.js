import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  base: './',
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'LICENSE'].map(entry => `node_modules/pdfjs-dist/${entry}`),
          dest: 'pdf-support',
          rename: { stripBase: 2 }
        }
      ]
    })
  ]
});
