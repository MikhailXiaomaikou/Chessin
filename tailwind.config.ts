import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/renderer/src/**/*.{tsx,ts,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        board: {
          light: '#f0d9b5',
          dark: '#b58863',
          highlight: 'rgba(255, 255, 0, 0.4)',
          check: 'rgba(255, 0, 0, 0.6)',
          lastMove: 'rgba(155, 199, 0, 0.41)'
        },
        eval: {
          white: '#ffffff',
          black: '#333333',
          draw: '#888888'
        },
        surface: {
          DEFAULT: '#1e1e1e',
          secondary: '#2d2d2d',
          tertiary: '#3d3d3d',
          hover: '#4d4d4d'
        },
        accent: {
          DEFAULT: '#769656',
          hover: '#8aad6a'
        }
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
}

export default config
