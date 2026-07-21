import { spawnSync } from "node:child_process";
import path from "node:path";

// 批量分析 + 趋势图生成：兼容本地与 Docker 环境变量
const input = process.env.FIT_INPUT_DIR || "input/";
const output = process.env.FIT_OUTPUT_DIR || "output/";
const trendPath = path.join(output, "fitness-trend.html");

const r1 = spawnSync("node", ["index.js", input, output], { stdio: "inherit" });
if (r1.status) process.exit(r1.status);

const r2 = spawnSync(
  "node",
  ["index.js", "--trend", "12", trendPath],
  { stdio: "inherit" },
);
if (r2.status) process.exit(r2.status);
