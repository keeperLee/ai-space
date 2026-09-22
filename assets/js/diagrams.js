/* ============================================================
   内嵌 SVG 示意图（跟随主题自动换色，无需外部图片资源）
   用法：:::diagram loop caption="图 1 · Agent 主循环"
   ============================================================ */

const box = (x, y, w, h, text, sub = '', accent = false, r = 9) => `
  <rect class="${accent ? 'dg-box-accent' : 'dg-box'}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>
  <text class="dg-text" x="${x + w / 2}" y="${sub ? y + h / 2 - 3 : y + h / 2 + 4}" text-anchor="middle">${text}</text>
  ${sub ? `<text class="dg-text-sm" x="${x + w / 2}" y="${y + h / 2 + 15}" text-anchor="middle">${sub}</text>` : ''}`;

const arrow = (x1, y1, x2, y2, id = 'a', dashed = false) =>
  `<path class="dg-line" d="M${x1} ${y1} L${x2} ${y2}" marker-end="url(#ar-${id})"${dashed ? ' stroke-dasharray="4 4"' : ''}/>`;

const curveArrow = (d, id = 'a') => `<path class="dg-line" d="${d}" marker-end="url(#ar-${id})"/>`;

const defs = (id) => `<defs>
    <marker id="ar-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="dg-arrow" d="M0 0 L10 5 L0 10 z"/>
    </marker>
  </defs>`;

const DIAGRAMS = {
  /* 主循环：感知 → 规划 → 行动 → 反思 */
  loop: () => `
<svg viewBox="0 0 680 268" role="img" aria-label="Agent 主循环示意图">
  ${defs('loop')}
  ${box(24, 96, 132, 58, '感知 Perceive', '接收目标 / 环境反馈', true)}
  ${box(192, 96, 132, 58, '规划 Plan', '拆解任务 / 选策略')}
  ${box(360, 96, 132, 58, '行动 Act', '调用工具 / 执行')}
  ${box(528, 96, 132, 58, '反思 Reflect', '评估结果 / 修正')}
  ${arrow(158, 125, 186, 125, 'loop')}
  ${arrow(326, 125, 354, 125, 'loop')}
  ${arrow(494, 125, 522, 125, 'loop')}
  ${curveArrow('M594 158 L594 226 Q594 236 584 236 L100 236 Q90 236 90 226 L90 160', 'loop')}
  <text class="dg-text-sm" x="342" y="256" text-anchor="middle">观察结果不满足终止条件 → 进入下一轮迭代</text>
</svg>`,

  /* 五大组件解剖 */
  anatomy: () => `
<svg viewBox="0 0 680 330" role="img" aria-label="Agent 系统解剖图">
  ${defs('anatomy')}
  ${box(240, 128, 200, 74, 'LLM 推理内核', '理解 · 决策 · 生成', true, 12)}
  ${box(24, 40, 168, 56, '规划器 Planner', '任务分解 / 重规划')}
  ${box(24, 200, 168, 56, '记忆 Memory', '短期上下文 / 长期库')}
  ${box(488, 40, 168, 56, '工具层 Tools', 'API / 数据库 / 代码')}
  ${box(488, 200, 168, 56, '执行环境 Runtime', '沙箱 / 状态 / 重试')}
  ${arrow(196, 74, 258, 132, 'anatomy')}
  ${arrow(196, 224, 258, 196, 'anatomy')}
  ${arrow(484, 74, 422, 132, 'anatomy')}
  ${arrow(484, 224, 422, 196, 'anatomy')}
  ${box(24, 118, 168, 44, '输入：用户目标', '', false, 8)}
  ${box(488, 118, 168, 44, '输出：任务结果', '', false, 8)}
  ${arrow(196, 140, 234, 140, 'anatomy')}
  ${arrow(446, 140, 484, 140, 'anatomy')}
  <text class="dg-text-sm" x="340" y="300" text-anchor="middle">五要素协同：模型负责思考，其余组件负责“记住、查找、动手、兜底”</text>
</svg>`,

  /* 记忆分层 */
  memory: () => `
<svg viewBox="0 0 680 300" role="img" aria-label="Agent 记忆分层示意图">
  ${defs('memory')}
  ${box(50, 30, 580, 56, '工作记忆 / 上下文窗口', '当前对话 · 最近的工具返回 · 临时状态（容量有限，最贵）', true)}
  ${box(90, 116, 500, 56, '会话记忆', '本轮任务的目标、已完成步骤、中间结论（task-scoped）')}
  ${box(130, 202, 420, 56, '长期记忆 / 外部知识库', '向量库 · 图数据库 · 用户画像（跨会话，可持久化）')}
  ${arrow(340, 86, 340, 112, 'memory')}
  ${arrow(340, 172, 340, 198, 'memory')}
  <text class="dg-text-sm" x="620" y="70" text-anchor="end">读：按需注入</text>
  <text class="dg-text-sm" x="60" y="196">写：摘要沉淀</text>
</svg>`,

  /* RAG 流程 */
  rag: () => `
<svg viewBox="0 0 680 250" role="img" aria-label="RAG 检索增强生成流程图">
  ${defs('rag')}
  ${box(20, 92, 104, 52, '文档入库', 'PDF/MD/DB')}
  ${box(146, 92, 104, 52, '切分 Chunking', '按语义分块', true)}
  ${box(272, 92, 104, 52, '向量化', 'Embedding')}
  ${box(398, 92, 104, 52, '检索召回', 'Top-K 相似')}
  ${box(524, 92, 132, 52, '重排 + 生成', 'Prompt 注入', true)}
  ${arrow(124, 118, 142, 118, 'rag')}
  ${arrow(250, 118, 268, 118, 'rag')}
  ${arrow(376, 118, 394, 118, 'rag')}
  ${arrow(502, 118, 520, 118, 'rag')}
  ${curveArrow('M590 144 L590 196 Q590 206 580 206 L78 206 Q68 206 68 196 L68 148', 'rag')}
  <text class="dg-text-sm" x="340" y="232" text-anchor="middle">离线构建知识库 ⇢ 在线检索并注入上下文，降低幻觉</text>
</svg>`,

  /* 单 Agent vs 多 Agent */
  multiAgent: () => `
<svg viewBox="0 0 680 300" role="img" aria-label="单 Agent 与多 Agent 架构对比">
  ${defs('multi')}
  <text class="dg-text" x="152" y="26" text-anchor="middle">单 Agent</text>
  ${box(46, 44, 212, 58, 'User Goal', '一个模型 + 一组工具', true)}
  ${arrow(152, 102, 152, 142, 'multi')}
  ${box(46, 142, 212, 58, 'ReAct Loop', '串行执行，状态集中')}
  ${arrow(152, 200, 152, 238, 'multi')}
  ${box(46, 238, 212, 46, 'Result', '')}
  <line class="dg-line" x1="330" y1="20" x2="330" y2="284" stroke-dasharray="5 6"/>
  <text class="dg-text" x="510" y="26" text-anchor="middle">多 Agent 协作</text>
  ${box(404, 44, 212, 58, 'Orchestrator', '拆解 · 派发 · 汇总', true)}
  ${box(360, 146, 92, 52, '研究员', '检索')}
  ${box(464, 146, 92, 52, '分析师', '计算')}
  ${box(568, 146, 92, 52, '写作者', '成文')}
  ${arrow(470, 102, 406, 142, 'multi')}
  ${arrow(510, 102, 510, 142, 'multi')}
  ${arrow(550, 102, 614, 142, 'multi')}
  ${box(404, 238, 212, 46, '共享黑板 / 消息总线', '')}
  ${arrow(406, 198, 448, 234, 'multi')}
  ${arrow(510, 198, 510, 234, 'multi')}
  ${arrow(614, 198, 572, 234, 'multi')}
</svg>`,

  /* 技术栈分层 */
  layers: () => `
<svg viewBox="0 0 680 286" role="img" aria-label="Agent 技术栈分层">
  ${defs('layers')}
  ${box(90, 20, 500, 48, '应用层 Application', '客服 · 编程助手 · 数据分析 · 研究助手', true)}
  ${box(90, 80, 500, 48, '编排层 Orchestration', '流程控制 · 状态机 · 多 Agent 路由 · 重试与超时')}
  ${box(90, 140, 500, 48, '能力层 Capability', '工具调用 · RAG 检索 · 记忆 · 代码执行 · 护栏')}
  ${box(90, 200, 500, 48, '模型层 Model', 'LLM 推理 · 多模态 · 微调 / 蒸馏 · 推理加速')}
  ${arrow(340, 68, 340, 76, 'layers')}
  ${arrow(340, 128, 340, 136, 'layers')}
  ${arrow(340, 188, 340, 196, 'layers')}
</svg>`,

  /* 护栏 */
  guardrail: () => `
<svg viewBox="0 0 680 230" role="img" aria-label="护栏部署位置示意图">
  ${defs('guard')}
  ${box(20, 84, 108, 56, '用户输入', '')}
  ${box(160, 78, 132, 68, '输入护栏', '注入检测 / 敏感词 / 越权', true)}
  ${box(324, 78, 132, 68, 'Agent 推理', '规划 · 工具调用', true)}
  ${box(488, 78, 132, 68, '输出护栏', '事实校验 / 隐私脱敏', true)}
  ${box(20, 178, 600, 40, '审计与可观测：全链路 Trace · 成本与延迟监控 · 人工兜底通道', '', false, 8)}
  ${arrow(128, 112, 156, 112, 'guard')}
  ${arrow(292, 112, 320, 112, 'guard')}
  ${arrow(456, 112, 484, 112, 'guard')}
  ${arrow(554, 146, 554, 174, 'guard')}
  ${arrow(340, 146, 340, 174, 'guard')}
</svg>`,

  /* 工具调用时序 */
  toolSeq: () => `
<svg viewBox="0 0 680 292" role="img" aria-label="工具调用时序图">
  ${defs('seq')}
  ${box(60, 18, 150, 46, 'LLM', '决策中枢', true)}
  ${box(286, 18, 150, 46, 'Agent Runtime', '调度与解析', true)}
  ${box(512, 18, 150, 46, '外部工具', 'API / DB / 沙箱')}
  <line class="dg-line" x1="135" y1="64" x2="135" y2="272" stroke-dasharray="4 5"/>
  <line class="dg-line" x1="361" y1="64" x2="361" y2="272" stroke-dasharray="4 5"/>
  <line class="dg-line" x1="587" y1="64" x2="587" y2="272" stroke-dasharray="4 5"/>
  ${arrow(135, 100, 359, 100, 'seq')}
  <text class="dg-text-sm" x="248" y="93" text-anchor="middle">① 返回 tool_calls（名称 + 参数 JSON）</text>
  ${arrow(361, 146, 585, 146, 'seq')}
  <text class="dg-text-sm" x="474" y="139" text-anchor="middle">② 校验参数并执行</text>
  ${arrow(585, 192, 363, 192, 'seq')}
  <text class="dg-text-sm" x="474" y="185" text-anchor="middle">③ 返回结构化结果 / 错误</text>
  ${arrow(361, 238, 137, 238, 'seq')}
  <text class="dg-text-sm" x="248" y="231" text-anchor="middle">④ 结果作为新消息注入上下文</text>
</svg>`,

  /* 任务分解树 */
  planTree: () => `
<svg viewBox="0 0 680 250" role="img" aria-label="规划与任务分解示意图">
  ${defs('plan')}
  ${box(250, 18, 180, 48, '目标：完成用户需求', '', true)}
  ${box(40, 110, 170, 48, '子任务 A · 检索', '可并行')}
  ${box(255, 110, 170, 48, '子任务 B · 计算', '可并行')}
  ${box(470, 110, 170, 48, '子任务 C · 汇总', '有依赖')}
  ${box(40, 190, 170, 44, '工具：搜索 API', '')}
  ${box(255, 190, 170, 44, '工具：代码沙箱', '')}
  ${box(470, 190, 170, 44, '工具：LLM 生成', '')}
  ${arrow(340, 66, 130, 106, 'plan')}
  ${arrow(340, 66, 340, 106, 'plan')}
  ${arrow(340, 66, 552, 106, 'plan')}
  ${arrow(125, 158, 125, 186, 'plan')}
  ${arrow(340, 158, 340, 186, 'plan')}
  ${arrow(555, 158, 555, 186, 'plan')}
</svg>`
};

export function getDiagram(name) {
  const fn = DIAGRAMS[name];
  if (!fn) return `<svg viewBox="0 0 200 60"><text class="dg-text-sm" x="10" y="34">[缺少示意图：${name}]</text></svg>`;
  return fn();
}

export const DIAGRAM_NAMES = Object.keys(DIAGRAMS);
