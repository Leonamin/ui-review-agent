import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    build: { outDir: 'dist', emptyOutDir: true },
    server: {
        host: '127.0.0.1', port: 4318, strictPort: true,
        fs: {
            allow: ['.', '../src', '../node_modules'].map(path => fileURLToPath(new URL(path, import.meta.url))),
            deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/runs/**', '**/evaluation/**'],
        },
    },
});
