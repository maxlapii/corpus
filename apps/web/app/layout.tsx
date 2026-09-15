import type { Metadata, Viewport } from 'next'
import './globals.css'
import { SessionProvider } from '@/components/session'

export const metadata: Metadata = {
  title: { default: 'CORPUS HR', template: '%s · CORPUS HR' },
  description: 'CORPUS — HR management and Telegram bot administration',
  applicationName: 'CORPUS HR',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  )
}
