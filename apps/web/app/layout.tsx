import type { Metadata } from 'next'
import './globals.css'
import { SessionProvider } from '@/components/session'

export const metadata: Metadata = {
  title: 'CORPUS — HR Admin',
  description: 'CORPUS HR management and AI assistant platform',
  robots: { index: false, follow: false },
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
