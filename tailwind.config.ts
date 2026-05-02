import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // 可以在这里扩展 Tailwind 颜色以匹配 Ant Design 主题
      },
    },
  },
  // 重要：禁用 Tailwind 的 preflight 以避免与 Ant Design 冲突
  corePlugins: {
    preflight: false,
  },
  plugins: [],
};

export default config;