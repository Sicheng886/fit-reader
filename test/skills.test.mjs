/**
 * skills.test.mjs — src/skills.js 技能文档加载回归测试。
 * 用 FIT_SKILLS_DIR 指向临时目录隔离（loadSkills 每次调用实时读环境变量与目录，
 * 无需在 import 前设置）；内置 skills/ 目录的默认加载亦做冒烟校验。
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { loadSkills, buildSkillsSection } = await import("../src/skills.js");

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fit-skills-test-"));
  process.env.FIT_SKILLS_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.FIT_SKILLS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name, content) {
  fs.writeFileSync(path.join(tmpDir, name), content, "utf8");
}

test("按文件名排序加载，标题取首个一级标题", () => {
  write("02-beta.md", "# Beta 技能\n\n正文 B");
  write("01-alpha.md", "# Alpha 技能\n\n正文 A");
  const skills = loadSkills();
  assert.equal(skills.length, 2);
  assert.equal(skills[0].title, "Alpha 技能");
  assert.equal(skills[1].title, "Beta 技能");
  assert.match(skills[0].content, /正文 A/);
});

test("_ 前缀与非 .md 文件跳过；无标题时用文件名兜底；空文件跳过", () => {
  write("_README.md", "# 说明\n\n不应注入");
  write("notes.txt", "不是 markdown");
  write("empty.md", "   \n");
  write("03-no-title.md", "没有标题行的正文");
  const skills = loadSkills();
  assert.equal(skills.length, 1);
  assert.equal(skills[0].title, "03-no-title");
});

test("目录不存在时返回空数组，buildSkillsSection 返回 null", () => {
  process.env.FIT_SKILLS_DIR = path.join(tmpDir, "not-exist");
  assert.deepEqual(loadSkills(), []);
  assert.equal(buildSkillsSection(), null);
});

test("buildSkillsSection 拼装专业知识库段", () => {
  write("01-a.md", "# 技能甲\n\n内容甲");
  write("02-b.md", "# 技能乙\n\n内容乙");
  const section = buildSkillsSection();
  assert.match(section, /^## 专业知识库/);
  assert.match(section, /### 技能甲\n\n内容甲/);
  assert.match(section, /### 技能乙\n\n内容乙/);
  assert.ok(section.indexOf("技能甲") < section.indexOf("技能乙"));
});

test("每次调用实时扫描：新增文件立即生效", () => {
  write("01-a.md", "# 技能甲\n\n内容甲");
  assert.equal(loadSkills().length, 1);
  write("02-b.md", "# 技能乙\n\n内容乙");
  assert.equal(loadSkills().length, 2);
});

test("内置 skills/ 目录默认加载四个技能且跳过 _README", () => {
  delete process.env.FIT_SKILLS_DIR; // 用仓库默认目录
  const titles = loadSkills().map((s) => s.title);
  assert.deepEqual(titles, [
    "Coggan 功率训练体系",
    "TrainingPeaks 负荷模型（CTL / ATL / TSB）",
    "心率区间与心率解读体系",
    "训练报告撰写规范",
  ]);
});
