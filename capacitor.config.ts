import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.chessin.app',
  appName: 'Chessin',
  webDir: 'dist-web',
  server: {
    androidScheme: 'https'
  }
}

export default config
