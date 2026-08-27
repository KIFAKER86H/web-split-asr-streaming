/**
 * Every family the caption box can be set to.
 *
 * All of them are downloaded at build time and served from this origin, so a
 * screen never depends on what happens to be installed on the machine viewing
 * it — which is the whole reason the picker offers a list instead of a free
 * text box. Geist carries no Thai glyphs; everything else here draws Thai and
 * Latin as one family.
 *
 * `preload` is off for everything but the UI faces and the default caption
 * face: the browser should fetch a family when someone actually picks it, not
 * pull nine Thai fonts down on first paint.
 *
 * Every option is spelled out as a literal — `subsets` and `weight` are read by
 * the compiler at build time, so a shared constant or a spread fails to build.
 * The weights match `CAPTION_FONT_WEIGHT`, which may be 200–500; a weight that
 * is not loaded gets faked by the browser and the letterforms distort.
 *
 * The CSS variable names below are repeated in `FONT_CHOICES`
 * (`src/lib/display.ts`), which is what the picker reads. Add a family here and
 * it has to be listed there too.
 */

import {
  Bai_Jamjuree,
  Geist,
  Geist_Mono,
  IBM_Plex_Sans_Thai,
  Kanit,
  Mitr,
  Noto_Sans_Thai,
  Noto_Serif_Thai,
  Prompt,
  Sarabun,
  Trirong,
} from "next/font/google";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * The default caption face, and the only Thai family that is preloaded — it is
 * what the box renders with until someone changes it.
 */
const prompt = Prompt({
  variable: "--font-caption",
  subsets: ["latin", "thai"],
  weight: ["200", "300", "400", "500"],
});

const sarabun = Sarabun({
  variable: "--font-sarabun",
  subsets: ["latin", "thai"],
  weight: ["200", "300", "400", "500"],
  preload: false,
});

const plexThai = IBM_Plex_Sans_Thai({
  variable: "--font-plex-thai",
  subsets: ["latin", "thai"],
  weight: ["200", "300", "400", "500"],
  preload: false,
});

const notoSansThai = Noto_Sans_Thai({
  variable: "--font-noto-thai",
  subsets: ["latin", "thai"],
  weight: ["200", "300", "400", "500"],
  preload: false,
});

const kanit = Kanit({
  variable: "--font-kanit",
  subsets: ["latin", "thai"],
  weight: ["200", "300", "400", "500"],
  preload: false,
});

const mitr = Mitr({
  variable: "--font-mitr",
  subsets: ["latin", "thai"],
  weight: ["200", "300", "400", "500"],
  preload: false,
});

const baiJamjuree = Bai_Jamjuree({
  variable: "--font-bai-jamjuree",
  subsets: ["latin", "thai"],
  weight: ["200", "300", "400", "500"],
  preload: false,
});

const notoSerifThai = Noto_Serif_Thai({
  variable: "--font-noto-serif-thai",
  subsets: ["latin", "thai"],
  weight: ["200", "300", "400", "500"],
  preload: false,
});

const trirong = Trirong({
  variable: "--font-trirong",
  subsets: ["latin", "thai"],
  weight: ["200", "300", "400", "500"],
  preload: false,
});

/** Every family's custom property, for the `<html>` class list. */
export const FONT_VARIABLES = [
  geistSans.variable,
  geistMono.variable,
  prompt.variable,
  sarabun.variable,
  plexThai.variable,
  notoSansThai.variable,
  kanit.variable,
  mitr.variable,
  baiJamjuree.variable,
  notoSerifThai.variable,
  trirong.variable,
].join(" ");
