import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://vibe.kexi.dev",
  integrations: [
    starlight({
      title: "vibe",
      head: [
        {
          tag: "script",
          content: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-KPMKW4GX');`,
        },
      ],
      components: {
        SocialIcons: "./src/components/CustomSocialIcons.astro",
        SkipLink: "./src/components/SkipLink.astro",
      },
      defaultLocale: "root",
      locales: {
        root: {
          label: "English",
          lang: "en",
        },
        ja: {
          label: "日本語",
          lang: "ja",
        },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/kexi/vibe",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/kexi/vibe/edit/main/docs/",
      },
      sidebar: [
        {
          label: "Introduction",
          translations: { ja: "はじめに" },
          items: [
            {
              slug: "index",
              label: "Welcome",
              translations: { ja: "ようこそ" },
            },
            {
              slug: "getting-started",
              label: "Getting Started",
              translations: { ja: "クイックスタート" },
            },
          ],
        },
        {
          label: "Installation",
          translations: { ja: "インストール" },
          items: [
            {
              slug: "installation",
              label: "Installation",
              translations: { ja: "インストール" },
            },
            {
              slug: "setup",
              label: "Shell Setup",
              translations: { ja: "シェル設定" },
            },
          ],
        },
        {
          label: "Configuration",
          translations: { ja: "設定" },
          autogenerate: { directory: "configuration" },
        },
        {
          label: "Commands",
          translations: { ja: "コマンド" },
          autogenerate: { directory: "commands" },
        },
        {
          label: "Security",
          translations: { ja: "セキュリティ" },
          autogenerate: { directory: "security" },
        },
        {
          slug: "changelog",
          label: "Changelog",
          translations: { ja: "変更履歴" },
        },
      ],
    }),
  ],
});
