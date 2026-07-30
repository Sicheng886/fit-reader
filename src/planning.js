/**
 * planning.js
 * 计划推演纯函数（无 IO，仿 src/ftp.js）：供 src/tools.js 的计算类工具调用。
 *
 * - simulateForm：给定当前 CTL/ATL 与未来逐日计划 TSS，按训练库同一递推口径
 *   （ctl += (tss - ctl)/42；atl += (tss - atl)/7，见 src/db.js computeForm）推演
 *   未来 CTL/ATL/TSB 走势，并按 FORM_SIMULATION 阈值标注风险。
 * - generateWorkout：按 WORKOUT_TEMPLATES 模板与可用时长拼装单次课表
 *   （热身/主组/冷身 + 瓦特区间 + TSS 估算），TSS 估算口径为逐段 时长秒 × IF² / 36。
 */

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * 未来负荷推演。
 * @param {object} p
 * @param {number} p.startCtl 起始 CTL（通常为当前值）
 * @param {number} p.startAtl 起始 ATL
 * @param {Array<{date:string,tss:number}>} p.plan 未来逐日计划（无训练日 tss=0），需按日期升序
 * @param {object} p.cfg FORM_SIMULATION 阈值配置
 * @returns {{projection: Array<[string,number,number,number]>, risk_flags: Array, end_form: object}}
 *   projection 每行为 [date, ctl, atl, tsb]（各保留 1 位小数）
 */
export function simulateForm({ startCtl, startAtl, plan, cfg }) {
  let ctl = Number(startCtl) || 0;
  let atl = Number(startAtl) || 0;
  const projection = [];
  for (const d of plan) {
    const tss = Number(d.tss) || 0;
    ctl += (tss - ctl) / 42;
    atl += (tss - atl) / 7;
    projection.push([d.date, r1(ctl), r1(atl), r1(ctl - atl)]);
  }

  const risk_flags = [];
  // TSB 持续低于阈值：找最长连续段，达到 cfg.tsb_low_days 即警示
  let runStart = -1;
  for (let i = 0; i <= projection.length; i++) {
    const low = i < projection.length && projection[i][3] < cfg.tsb_low;
    if (low && runStart < 0) runStart = i;
    if (!low && runStart >= 0) {
      const days = i - runStart;
      if (days >= cfg.tsb_low_days) {
        risk_flags.push({
          type: "tsb_low_sustained",
          start: projection[runStart][0],
          end: projection[i - 1][0],
          days,
          message: `TSB 连续 ${days} 天低于 ${cfg.tsb_low}，深度疲劳风险`,
        });
      }
      runStart = -1;
    }
  }
  // CTL 周增幅超阈：相邻 7 天窗口（起点 CTL > 0 才有百分比意义）
  for (let i = 7; i < projection.length; i++) {
    const prev = projection[i - 7][1];
    if (prev <= 0) continue;
    const ramp = ((projection[i][1] - prev) / prev) * 100;
    if (ramp > cfg.ctl_ramp_pct) {
      risk_flags.push({
        type: "ctl_ramp_high",
        start: projection[i - 7][0],
        end: projection[i][0],
        ramp_pct: r1(ramp),
        message: `CTL 周增幅 ${r1(ramp)}% 超过 ${cfg.ctl_ramp_pct}%，过度训练风险`,
      });
    }
  }

  const last = projection[projection.length - 1];
  return {
    projection,
    risk_flags,
    end_form: last ? { ctl: last[1], atl: last[2], tsb: last[3] } : null,
  };
}

/** 功率百分比区间 → 瓦特区间（取整） */
const toWatts = (pct, ftp) => [Math.round(ftp * pct[0]), Math.round(ftp * pct[1])];

/** 段的 TSS 贡献：时长秒 × IF² / 36（TSS = h × IF² × 100 的逐段形式） */
const segTss = (minutes, intensityFactor) => (minutes * 60 * intensityFactor * intensityFactor) / 36;

// 热身/冷身/组间休息的统一低强度口径（Z1）
const LOW = { pct: [0.4, 0.55], if: 0.5 };

/**
 * 单次课表生成。
 * @param {object} p
 * @param {string} p.target 课表类型（WORKOUT_TEMPLATES 的 key）
 * @param {number} p.durationMinutes 可用总时长（分钟）
 * @param {number} p.ftpWatts 骑手 FTP
 * @param {number|null} [p.tsb] 当前 TSB；低于 tsbRecovery 阈值时自动降级为恢复课
 * @param {object} p.templates WORKOUT_TEMPLATES 配置
 * @param {number} p.tsbRecovery TSB 降级阈值（FORM_SIMULATION.tsb_recovery）
 * @returns 课表结构，或 { error }（未知类型 / 时长不足）
 */
export function generateWorkout({ target, durationMinutes, ftpWatts, tsb = null, templates, tsbRecovery }) {
  const notes = [];
  let key = target;
  if (tsb != null && Number.isFinite(Number(tsb)) && Number(tsb) < tsbRecovery && key !== "recovery") {
    notes.push(`当前 TSB ${r1(Number(tsb))} 低于 ${tsbRecovery}，身体未恢复，自动降级为恢复骑`);
    key = "recovery";
  }
  const tpl = templates[key];
  if (!tpl) return { error: `未知课表类型: ${target}（可选: ${Object.keys(templates).join("/")}）` };
  const dur = Number(durationMinutes);

  // 稳态课（恢复/有氧耐力）：全程一个强度
  if (tpl.steady) {
    const tss = segTss(dur, tpl.steady.if);
    return {
      target: key,
      label: tpl.label,
      duration_minutes: dur,
      steady: { minutes: dur, power_watts: toWatts(tpl.steady.pct, ftpWatts) },
      estimated_tss: r1(tss),
      notes,
    };
  }

  // 间歇课：热身 → 主组（组数夹在模板范围内，单组时长由可用时长推算）→ 冷身
  const avail = dur - tpl.warmup_min - tpl.cooldown_min;
  let chosen = null;
  for (let reps = tpl.reps[1]; reps >= tpl.reps[0]; reps--) {
    // rest_min 为 null 时组间休息与单组等时（如 VO2max）
    let setMin;
    if (tpl.rest_min == null) {
      setMin = Math.floor(avail / (2 * reps - 1)); // r 组 + (r-1) 次等时休息
    } else {
      setMin = Math.floor((avail - (reps - 1) * tpl.rest_min) / reps);
    }
    setMin = Math.min(setMin, tpl.set.max_min);
    if (setMin >= tpl.set.min_min) {
      chosen = { reps, setMin, restMin: tpl.rest_min ?? setMin };
      break;
    }
  }
  if (!chosen) {
    return {
      error: `${dur} 分钟装不下 ${tpl.label} 课表（热身 ${tpl.warmup_min} + 至少 ${tpl.reps[0]}×${tpl.set.min_min} 分钟主组 + 冷身 ${tpl.cooldown_min}），请增加时长或换低时长课表`,
    };
  }

  const { reps, setMin, restMin } = chosen;
  const mainMin = reps * setMin + (reps - 1) * restMin;
  // 剩余时长并入冷身，保证各段合计 = 总时长
  const cooldownMin = dur - tpl.warmup_min - mainMin;

  const tss =
    segTss(tpl.warmup_min, LOW.if) +
    reps * segTss(setMin, tpl.set.if) +
    (reps - 1) * segTss(restMin, LOW.if) +
    segTss(cooldownMin, LOW.if);

  return {
    target: key,
    label: tpl.label,
    duration_minutes: dur,
    warmup: { minutes: tpl.warmup_min, power_watts: toWatts(LOW.pct, ftpWatts) },
    main_sets: {
      reps,
      set_minutes: setMin,
      power_watts: toWatts(tpl.set.pct, ftpWatts),
      rest_minutes: restMin,
      rest_power_watts: toWatts(LOW.pct, ftpWatts),
    },
    cooldown: { minutes: cooldownMin, power_watts: toWatts(LOW.pct, ftpWatts) },
    estimated_tss: r1(tss),
    notes,
  };
}
