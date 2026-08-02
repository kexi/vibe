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
        Head: "./src/components/Head.astro",
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
        zh: {
          label: "简体中文",
          lang: "zh-CN",
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
          translations: { ja: "はじめに", zh: "简介" },
          items: [
            {
              slug: "index",
              label: "Welcome",
              translations: { ja: "ようこそ", zh: "欢迎" },
            },
            {
              slug: "getting-started",
              label: "Getting Started",
              translations: { ja: "クイックスタート", zh: "快速开始" },
            },
          ],
        },
        {
          label: "Installation",
          translations: { ja: "インストール", zh: "安装" },
          items: [
            {
              slug: "installation",
              label: "Installation",
              translations: { ja: "インストール", zh: "安装" },
            },
            {
              slug: "setup",
              label: "Shell Setup",
              translations: { ja: "シェル設定", zh: "Shell 设置" },
            },
          ],
        },
        {
          label: "Configuration",
          translations: { ja: "設定", zh: "配置" },
          items: [{ autogenerate: { directory: "configuration" } }],
        },
        {
          label: "Commands",
          translations: { ja: "コマンド", zh: "命令" },
          items: [{ autogenerate: { directory: "commands" } }],
        },
        {
          label: "Recipes",
          translations: { ja: "レシピ集", zh: "实用方案" },
          items: [{ autogenerate: { directory: "recipes" } }],
        },
        {
          label: "Security",
          translations: { ja: "セキュリティ", zh: "安全" },
          items: [{ autogenerate: { directory: "security" } }],
        },
        {
          slug: "changelog",
          label: "Changelog",
          translations: { ja: "変更履歴", zh: "更新日志" },
        },
      ],
    }),
  ],
});
