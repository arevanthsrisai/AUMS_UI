import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-') || id.includes('node_modules/d3')) return 'charts';
          if (id.includes('node_modules/framer-motion') || id.includes('node_modules/motion')) return 'motion';
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react-vendor';
          if (id.includes('node_modules/lucide-react')) return 'icons';
        }
      }
    }
  }
})
