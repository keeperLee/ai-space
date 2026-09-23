// 后续项目在这里添加：title、description、category、href、icon、tags。
// href 支持站内相对路径与站外绝对地址：站外项目会自动在新标签页打开，
// 可用 action 自定义卡片按钮文案（默认「进入项目 ↗」/「在新标签页打开 ↗」）。
export const projects = [
  {
    title: 'Agent 学习平台',
    description: '从基础概念到工程实战，系统学习 AI Agent。继续你的课程、笔记与动手实验。',
    category: '学习与成长',
    href: './projects/agent-learning/learning.html',
    icon: 'A',
    tags: ['26 章课程', '交互演示', '实战案例'],
  },
  {
    title: 'mini-rag 迷你 RAG 知识库',
    description: '不用任何 RAG 框架，从零手写加载、切分、检索到生成的完整链路，再用 MCP 变成 agent 可调用的工具。',
    category: '学习与成长',
    href: 'https://github.com/keeperLee/mini-rag',
    icon: 'R',
    tags: ['6 步拆解', 'BM25 + RRF', 'MCP 接入'],
    action: '查看源码 ↗',
  },
];
