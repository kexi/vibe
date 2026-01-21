import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { ReactNode } from "react";

const GOOGLE_FONTS_API_URL =
  "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@700&display=swap";

let fontData: ArrayBuffer | null = null;

async function loadFont(): Promise<ArrayBuffer> {
  if (fontData) {
    return fontData;
  }

  const cssResponse = await fetch(GOOGLE_FONTS_API_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });

  const isCssResponseOk = cssResponse.ok;
  if (!isCssResponseOk) {
    throw new Error(
      `Failed to fetch font CSS: ${cssResponse.status} ${cssResponse.statusText}`
    );
  }

  const css = await cssResponse.text();

  const fontUrlMatch = css.match(/src: url\(([^)]+)\)/);
  if (!fontUrlMatch) {
    throw new Error("Could not find font URL in CSS");
  }

  const fontUrl = fontUrlMatch[1];
  const fontResponse = await fetch(fontUrl);

  const isFontResponseOk = fontResponse.ok;
  if (!isFontResponseOk) {
    throw new Error(
      `Failed to fetch font file: ${fontResponse.status} ${fontResponse.statusText}`
    );
  }

  fontData = await fontResponse.arrayBuffer();

  return fontData;
}

export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection("docs");
  return docs.map((doc) => ({
    params: { slug: doc.id },
    props: { title: doc.data.title, description: doc.data.description },
  }));
};

interface Props {
  title: string;
  description?: string;
}

export const GET: APIRoute<Props> = async ({ props }) => {
  try {
    const { title, description } = props;
    const font = await loadFont();

    const svg = await satori(
      {
        type: "div",
        props: {
          style: {
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "60px",
            background:
              "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
            fontFamily: "Noto Sans JP",
          },
          children: [
            {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "24px",
                },
                children: [
                  {
                    type: "div",
                    props: {
                      style: {
                        fontSize: "32px",
                        fontWeight: "bold",
                        color: "#94a3b8",
                        letterSpacing: "0.1em",
                      },
                      children: "vibe",
                    },
                  },
                  {
                    type: "div",
                    props: {
                      style: {
                        fontSize: "56px",
                        fontWeight: "bold",
                        color: "#ffffff",
                        lineHeight: 1.3,
                        maxWidth: "900px",
                      },
                      children: title,
                    },
                  },
                  description
                    ? {
                        type: "div",
                        props: {
                          style: {
                            fontSize: "28px",
                            color: "#94a3b8",
                            lineHeight: 1.5,
                            maxWidth: "800px",
                          },
                          children: description,
                        },
                      }
                    : null,
                ].filter(Boolean),
              },
            },
            {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "center",
                },
                children: [
                  {
                    type: "div",
                    props: {
                      style: {
                        fontSize: "24px",
                        color: "#64748b",
                      },
                      children: "vibe.kexi.dev",
                    },
                  },
                ],
              },
            },
          ],
        },
      } as ReactNode,
      {
        width: 1200,
        height: 630,
        fonts: [
          {
            name: "Noto Sans JP",
            data: font,
            weight: 700,
            style: "normal",
          },
        ],
      }
    );

    const resvg = new Resvg(svg, {
      fitTo: {
        mode: "width",
        value: 1200,
      },
    });
    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();

    return new Response(new Uint8Array(pngBuffer), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("Failed to generate OG image:", error);
    return new Response("Failed to generate image", {
      status: 500,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  }
};
