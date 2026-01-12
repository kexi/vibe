import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://vibe.kexi.dev",
  integrations: [
    starlight({
      title: "vibe",
      defaultLocale: "en",
      locales: {
        en: {
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
