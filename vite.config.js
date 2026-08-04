import { defineConfig } from 'vite'

// GitHub Pages はリポジトリ名配下で配信される。通常のローカル/独自ドメインは '/'.
export default defineConfig({ base: process.env.VITE_BASE_PATH || '/' })
