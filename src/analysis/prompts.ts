export const ANALYSIS_SYSTEM_PROMPT = `你是一个专业的播客内容分析师。你的任务是对播客转录文本进行深度分析，提取关键信息并生成结构化的分析报告。

核心原则：
1. 使用中文进行所有分析和输出
2. 内容准确、客观，严格忠实于原文，不要引入任何剧集以外的信息
3. 分析要有深度，不是简单的复述
4. 长版纪要应尽可能还原剧集的完整内容和上下文`;

export function buildAnalysisPrompt(
  transcript: string,
  episodeTitle: string,
  podcastName: string,
  options: {
    summaryMinLength: number;
    summaryMaxLength: number;
    keyPointsCount: number;
  }
): string {
  return `请对以下播客内容进行深度分析：

播客名称：${podcastName}
剧集标题：${episodeTitle}

转录文本：
${transcript}

请按以下JSON格式输出分析结果（注意必须是合法的JSON）：

{
  "summary": "（约800字的内容核心摘要，概括剧集的核心主题、主要讨论内容和结论）",
  "keyPoints": [
    {
      "title": "要点标题（简短概括，10-20字）",
      "detail": "该要点的详细展开内容（不少于800字）。深入阐述该要点涉及的具体讨论、论据、数据、案例和参与者的具体观点。要求内容丰富、有深度，能让读者仅通过阅读此内容就充分理解该要点。"
    }
  ],
  "keywords": [
    {
      "word": "核心关键词/术语",
      "context": "该关键词在本剧集中的具体含义和讨论背景（200-400字），包括谁提到了它、在什么语境下讨论、得出了什么结论"
    }
  ],
  "fullRecap": "（3000-5000字的长版内容纪要。按照剧集的时间线和讨论顺序，尽可能完整地还原剧集的全部内容。包括：讨论的每个话题、参与者的具体发言和观点、引用的数据和案例、话题之间的过渡和关联。注意：只基于转录文本中的内容，不要引入任何外部信息。）"
}

要求：
1. summary 约800字，精炼但完整地涵盖核心内容
2. keyPoints 提取${options.keyPointsCount}个最重要的要点，每个要点的detail不少于800字
3. keywords 提取8-15个核心关键词，每个关键词都要有充分的上下文说明
4. fullRecap 3000-5000字，按时间线还原完整内容，严格基于转录文本，不引入外部信息
5. 所有内容使用中文（如涉及英文专有名词可保留原文并附中文说明）
6. 只输出JSON，不要有其他文字`;
}

/** 分段摘要 prompt：对长文本的一个片段提取详细摘要 */
export function buildChunkSummaryPrompt(
  chunk: string,
  chunkIndex: number,
  totalChunks: number,
  episodeTitle: string,
  podcastName: string
): string {
  return `你正在分析一个较长的播客剧集。这是转录文本的第 ${chunkIndex} 部分（共 ${totalChunks} 部分）。

播客名称：${podcastName}
剧集标题：${episodeTitle}

请对这部分内容生成一份精炼的摘要，要求：
1. 保留重要的讨论话题、核心观点和关键论据
2. 记录参与者的主要立场
3. 保持内容的时间顺序
4. 标注关键术语和专有名词
5. 摘要长度约 800-1200 字，抓住核心信息

转录文本片段：
${chunk}

请直接输出摘要文本，不需要JSON格式。`;
}

/** 合并分析 prompt：基于所有分段摘要生成最终结构化分析 */
export function buildMergeAnalysisPrompt(
  mergedSummaries: string,
  episodeTitle: string,
  podcastName: string,
  options: {
    summaryMinLength: number;
    summaryMaxLength: number;
    keyPointsCount: number;
  }
): string {
  return `以下是一个较长播客剧集的分段摘要汇总。请基于这些摘要，生成完整的结构化分析报告。

播客名称：${podcastName}
剧集标题：${episodeTitle}

各部分摘要：
${mergedSummaries}

请按以下JSON格式输出分析结果（注意必须是合法的JSON）：

{
  "summary": "（约800字的内容核心摘要，概括剧集的核心主题、主要讨论内容和结论）",
  "keyPoints": [
    {
      "title": "要点标题（简短概括，10-20字）",
      "detail": "该要点的详细展开内容（不少于800字）。深入阐述该要点涉及的具体讨论、论据、数据、案例和参与者的具体观点。要求内容丰富、有深度，能让读者仅通过阅读此内容就充分理解该要点。"
    }
  ],
  "keywords": [
    {
      "word": "核心关键词/术语",
      "context": "该关键词在本剧集中的具体含义和讨论背景（200-400字），包括谁提到了它、在什么语境下讨论、得出了什么结论"
    }
  ],
  "fullRecap": "（3000-5000字的长版内容纪要。按照剧集的时间线和讨论顺序，尽可能完整地还原剧集的全部内容。包括：讨论的每个话题、参与者的具体发言和观点、引用的数据和案例、话题之间的过渡和关联。注意：只基于摘要中的内容，不要引入任何外部信息。）"
}

要求：
1. summary 约800字，精炼但完整地涵盖核心内容
2. keyPoints 提取${options.keyPointsCount}个最重要的要点，每个要点的detail不少于800字
3. keywords 提取8-15个核心关键词，每个关键词都要有充分的上下文说明
4. fullRecap 3000-5000字，按时间线还原完整内容，综合所有部分的摘要
5. 所有内容使用中文（如涉及英文专有名词可保留原文并附中文说明）
6. 只输出JSON，不要有其他文字`;
}
