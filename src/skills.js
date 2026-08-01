/**
 * skills.js
 * 技能文档系统：从 skills/ 目录加载训练科学知识库（Markdown），
 * 拼成提示词段注入服务端 AI 报告生成与直接对话，保证切换任意 AI 模型
 * 都能拿到口径一致的领域知识，维持报告质量。
 *
 * 用户扩充方式：直接往 skills/ 目录放 .md 文件即可（无需改代码、无 Web UI）：
 * - 按文件名排序加载，建议 NN-名称.md 数字前缀控制注入顺序；
 * - 文件名以 _ 开头的不注入（如 _README.md 说明文档）；
 * - 每次 AI 请求时实时扫描目录（不缓存），新文件即刻生效、无需重启。
 * 目录可用环境变量 FIT_SKILLS_DIR 覆盖（测试隔离，风格同 FIT_DB_PATH）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");

function skillsDir() {
  return process.env.FIT_SKILLS_DIR || DEFAULT_DIR;
}

/** 从 Markdown 内容提取标题：首个 `# ` 一级标题行，缺失返回 null */
function extractTitle(content) {
  const m = /^#\s+(.+)$/m.exec(content);
  return m ? m[1].trim() : null;
}

/** 去掉内容中首个 `# ` 一级标题行（标题已用作小节标题，正文不再重复） */
function stripTitleLine(content) {
  return content.replace(/^#\s+.+\n?/m, "").trim();
}

/**
 * 加载全部技能文件，返回 [{ title, content }]（按文件名排序）。
 * 目录不存在/无有效文件时返回 []；单个文件读取失败仅警告并跳过。
 */
export function loadSkills() {
  const dir = skillsDir();
  let names;
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".md") && !n.startsWith("_"))
      .sort();
  } catch {
    return []; // 目录不存在等情况：无技能可用
  }
  const skills = [];
  for (const name of names) {
    try {
      const content = fs.readFileSync(path.join(dir, name), "utf8").trim();
      if (!content) continue;
      const title = extractTitle(content);
      skills.push({
        title: title ?? name.replace(/\.md$/, ""),
        content: title ? stripTitleLine(content) : content,
      });
    } catch (err) {
      console.warn(`[skills] 读取 ${name} 失败，已跳过: ${err.message}`);
    }
  }
  return skills;
}

/**
 * 把技能拼成「专业知识库」提示词段；无技能时返回 null（调用方 filter(Boolean)）。
 * 全文注入：每个技能保留原 Markdown 正文，标题统一降为三级。
 */
export function buildSkillsSection() {
  const skills = loadSkills();
  if (!skills.length) return null;
  const body = skills.map((s) => `### ${s.title}\n\n${s.content}`).join("\n\n");
  return (
    `## 专业知识库\n\n` +
    `以下是本系统收录的训练科学参考资料，解读数据与撰写报告时以其口径、阈值与标准为准` +
    `（与「指标口径与骑手参数」段冲突时以指标口径段为准——后者反映当前骑手的实际参数）。\n\n` +
    body
  );
}
