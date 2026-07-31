/**
 * views/about.js — 关于页（功能说明 / 最近更新 / 作者）
 */

import { app, esc } from "../common.js";

export function renderAbout() {
  app.innerHTML = `
    <div class="view-title"><h1>关于</h1><span class="sub">fit-reader · 本地骑行/运动数据分析</span></div>

    <div class="panel">
      <div class="panel-title">功能说明</div>
      <ul class="about-list">
        <li>批量解析码表/运动手表导出的 <code>.fit</code> 文件，输出按秒对齐的 <code>records.csv</code> 与汇总 <code>summary.json</code>。</li>
        <li>自动计算 NP、IF、TSS、VI、功体比、峰功率曲线、功率/心率分区、心率漂移（有氧解耦）、间歇与爬坡识别。</li>
        <li>本地 SQLite 训练库长期归档，自动追踪 CTL/ATL/TSB 体能/疲劳/状态趋势。</li>
        <li>Web 仪表盘：概览、训练列表、详情时序图、上传、AI 报告、AI 对话、记忆管理与设置。</li>
        <li>AI 报告：单次复盘、周期规划、赛前减量、两次训练对比，支持自动调用本地训练库工具查询数据。</li>
        <li>Agentic 对话：AI 可查询活动、推演未来负荷、生成单次课表、保存并复用用户记忆。</li>
        <li>支持骑行、跑步、游泳三类运动，骑行指标最完整。</li>
      </ul>
    </div>

    <div class="panel">
      <div class="panel-title">最近更新</div>
      <ul class="about-list">
        <li>AI 顾问支持 agentic 工具调用与多轮对话，可主动查训练库、算负荷、写课表。</li>
        <li>新增 AI 记忆：AI 在交互中自动记录并复用用户相关事实，记忆页可查看与删除。</li>
        <li>新增负荷推演（simulate_form）与单次课表生成（generate_workout）工具。</li>
        <li>AI 对话支持持久化与后台生成，提交后可关闭页面，事后回看结果。</li>
        <li>Web 设置页支持骑手参数、AI 服务配置、身份与训练目标维护；FTP 估算结果可一键应用。</li>
        <li>新增本「关于」页面，汇总功能说明与更新内容。</li>
      </ul>
    </div>

    <div class="panel">
      <div class="panel-title">作者</div>
      <p class="muted">Wally Yang</p>
    </div>`;
}
