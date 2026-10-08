import { defineConfig } from 'vitepress'
import { chapters } from '../manifest'

const base = process.env.DOCS_BASE ?? '/goodbuddy/docs-dist/'

const sidebar = (language: 'zh' | 'en') => [
  {
    text: language === 'zh' ? '用户手册' : 'User guide',
    items: chapters.map(({ slug, title }) => ({
      text: title[language],
      link: `/${language}/${slug === 'start' ? '' : `${slug}.html`}`,
    })),
  },
]

export default defineConfig({
  title: 'GoodBuddy',
  description: 'GoodBuddy user guide',
  base,
  srcDir: 'content',
  rewrites: {
    'zh/start.md': 'zh/index.md',
    'en/start.md': 'en/index.md',
  },
  locales: {
    root: { label: 'English', lang: 'en', link: '/en/' },
    zh: { label: '简体中文', lang: 'zh-CN', link: '/zh/' },
  },
  themeConfig: {
    siteTitle: 'GoodBuddy',
    search: { provider: 'local' },
    outline: 'deep',
    sidebar: {
      '/zh/': sidebar('zh'),
      '/en/': sidebar('en'),
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/mesalogo/goodbuddy' }],
    locales: {
      root: {
        langMenuLabel: '语言',
        nav: [
          { text: 'Home', link: 'https://mesalogo.github.io/goodbuddy/en.html' },
          { text: 'GitHub', link: 'https://github.com/mesalogo/goodbuddy' },
        ],
      },
      zh: {
        langMenuLabel: 'Languages',
        nav: [
          { text: '官网首页', link: 'https://mesalogo.github.io/goodbuddy/' },
          { text: 'GitHub', link: 'https://github.com/mesalogo/goodbuddy' },
        ],
      },
    },
  },
})
