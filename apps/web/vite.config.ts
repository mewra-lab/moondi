import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      useCredentials: true,
      includeAssets: ['icon-180.png', 'icon-192.png', 'icon-512.png', 'og.png'],
      manifest: {
        name: 'Moondi Portfolio',
        short_name: 'Moondi',
        description: 'Private crypto portfolio tracking',
        theme_color: '#0f1720',
        background_color: '#f3f0e8',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        importScripts: ['push-handler.js'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/cdn-cgi\//, /^\/login$/]
      }
    })
  ]
})
