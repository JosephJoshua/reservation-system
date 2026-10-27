import { defineConfig } from 'vitepress'

const student = [
  {
    text: '学员',
    items: [
      { text: '开始使用', link: '/student/' },
      { text: '预约课程', link: '/student/book' },
      { text: '购买课时包', link: '/student/packages' },
      { text: '改约与取消', link: '/student/change' },
      { text: '到场签到', link: '/student/check-in' },
      { text: '课后点评', link: '/student/feedback' },
      { text: '申请发票', link: '/student/invoices' },
      { text: '个人信息与账号', link: '/student/account' },
      { text: '常见问题', link: '/student/faq' },
    ],
  },
]

const coach = [
  {
    text: '教练',
    items: [
      { text: '开始使用', link: '/coach/' },
      { text: '查看课表', link: '/coach/schedule' },
      { text: '上课与签到', link: '/coach/lesson' },
      { text: '学员档案', link: '/coach/profile' },
      { text: '写课后点评', link: '/coach/feedback' },
      { text: '改约与取消', link: '/coach/change' },
      { text: '排班、请假与加班', link: '/coach/hours' },
    ],
  },
]

const admin = [
  {
    text: '入门',
    items: [
      { text: '登录与界面', link: '/admin/' },
      { text: '员工与权限', link: '/admin/staff' },
    ],
  },
  {
    text: '日常',
    items: [
      { text: '今日签到', link: '/admin/today' },
      { text: '日程与排班', link: '/admin/schedule' },
      { text: '代约', link: '/admin/book' },
      { text: '预约与课程详情', link: '/admin/bookings' },
      { text: '学员', link: '/admin/students' },
      { text: '小班课', link: '/admin/group-classes' },
    ],
  },
  {
    text: '财务',
    items: [
      { text: '订单与退款', link: '/admin/refunds' },
      { text: '发票', link: '/admin/invoices' },
      { text: '概览与报表', link: '/admin/reports' },
      { text: '教练课时费', link: '/admin/coach-pay' },
    ],
  },
  {
    text: '课程与内容',
    items: [
      { text: '课程', link: '/admin/courses' },
      { text: '教练', link: '/admin/coaches' },
      { text: '课时包', link: '/admin/products' },
      { text: '首页内容', link: '/admin/home' },
    ],
  },
  {
    text: '系统',
    items: [
      { text: '设置', link: '/admin/settings' },
      { text: '操作记录', link: '/admin/action-log' },
      { text: '在手机上使用', link: '/admin/phone' },
    ],
  },
]

export default defineConfig({
  lang: 'zh-CN',
  title: 'Lumi乒乓 使用手册',
  titleTemplate: ':title · Lumi乒乓 使用手册',
  description: 'Lumi乒乓 预约小程序与管理后台的使用说明',
  // Served by the API next to the admin app, at https://<domain>/help/.
  base: '/help/',
  srcExclude: ['README.md'],
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/help/favicon.svg' }]],
  lastUpdated: false,
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: '使用手册',
    nav: [
      { text: '学员', link: '/student/', activeMatch: '^/student/' },
      { text: '教练', link: '/coach/', activeMatch: '^/coach/' },
      { text: '前台与管理', link: '/admin/', activeMatch: '^/admin/' },
    ],
    sidebar: { '/student/': student, '/coach/': coach, '/admin/': admin },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色',
    darkModeSwitchTitle: '切换到深色',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    langMenuLabel: '语言',
    notFound: {
      title: '没有找到这个页面',
      quote: '页面可能已经移动或删除。',
      linkLabel: '回到首页',
      linkText: '回到首页',
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
          modal: {
            displayDetails: '显示详情',
            resetButtonTitle: '清除',
            backButtonTitle: '关闭',
            noResultsText: '没有找到相关内容',
            footer: { selectText: '打开', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },
  },
})
