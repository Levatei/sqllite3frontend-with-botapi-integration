import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Data Console — SQLite workspace',
  description: 'Профессиональный интерфейс для управления существующей SQLite-базой.',
  viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
