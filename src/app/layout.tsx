import type { CSSProperties, ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { connection } from "next/server";

import { FONT_VARIABLES } from "@/app/fonts";
import { CaptionSettingsProvider } from "@/hooks/useCaptionSettings";
import { captionCssVars, resolveCaptionSettings } from "@/lib/caption";
import { BOOTSTRAP_SCRIPT } from "@/lib/display";
import { captionConfig } from "@/lib/server/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "StreamingASR — Split",
  description:
    "ถอดเสียงพูดเป็นข้อความและแปลภาษาแบบเรียลไทม์ แยกจอถอดเสียงกับจอแปลออกจากกัน ประสานผ่าน SharedWorker",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

/**
 * Reads the configuration once for the whole app.
 *
 * `connection()` holds the render until a request arrives, which keeps `.env` a
 * runtime concern — without it the values would be read at build time and baked
 * into a prerendered document.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  await connection();

  const settings = resolveCaptionSettings(captionConfig());

  return (
    <html
      lang="th"
      className={`${FONT_VARIABLES} h-full antialiased`}
      // The `.env` layer. Server-rendered, so the first paint is already at the
      // configured size; the viewer's own overrides land on `<body>` below and
      // win by being further down the tree.
      style={captionCssVars(settings) as CSSProperties}
    >
      {/*
        The bootstrap script below writes custom properties onto this element
        before React hydrates, so the live DOM carries a `style` attribute the
        server never rendered. That is the intended design, not a drift bug —
        without the suppression React reports it as a hydration mismatch on
        every load that has a saved override.
      */}
      <body className="min-h-full bg-black" suppressHydrationWarning>
        {/*
          Runs before anything is painted, which is the whole point — an effect
          would fire after the first frame and the text would visibly jump from
          the `.env` size to the saved one.
        */}
        <script dangerouslySetInnerHTML={{ __html: BOOTSTRAP_SCRIPT }} />
        <CaptionSettingsProvider settings={settings}>
          {children}
        </CaptionSettingsProvider>
      </body>
    </html>
  );
}
