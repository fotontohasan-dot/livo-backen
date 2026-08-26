import { Html, Head, Main, NextScript } from 'next/document';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

export default function Document() {
  return (
    <Html lang="en" suppressHydrationWarning>
      <Head>
        {/* Runs before first paint so the stored/system theme applies
            immediately — no flash of the wrong theme on load or refresh. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </Head>
      <body suppressHydrationWarning>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
