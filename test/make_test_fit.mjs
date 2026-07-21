/**
 * make_test_fit.mjs
 * 合成 FIT 文件生成器（回归测试用，README 中 make_test_fit.py 的落地版）。
 * 手工拼装 FIT 二进制：14 字节文件头 + 定义消息/数据消息 + CRC-16，不依赖第三方库。
 * 覆盖：骑行（含功率缺失/记录缺失/无时间戳坏记录）、跑步、游泳（length 消息）、开发者字段。
 *
 * 既可被测试 import，也可直接运行生成样例文件：
 *   node test/make_test_fit.mjs [输出目录]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// FIT 时间戳基准：1989-12-31 00:00:00 UTC
export const FIT_EPOCH = 631065600;

// ---------------- CRC-16（FIT 官方半字节查表算法） ----------------
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001,
  0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function crc16(bytes, crc = 0) {
  for (const b of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

// ---------------- 二进制拼装辅助 ----------------

const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};

// FIT 基础类型标识（定义消息第 3 字节）
const BASE = { enum: 0x00, sint8: 0x01, uint8: 0x02, string: 0x07, byte: 0x0d, uint16: 0x84, uint32: 0x86 };

/** 定义消息：fields = [{ num, size, base }]；devFields = [{ num, size, devIndex }]（可选） */
function defMsg(local, globalNum, fields, devFields = null) {
  const header = 0x40 | local | (devFields ? 0x20 : 0);
  const parts = [u8(header), u8(0), u8(0), u16(globalNum), u8(fields.length)];
  for (const f of fields) parts.push(u8(f.num), u8(f.size), u8(f.base));
  if (devFields) {
    parts.push(u8(devFields.length));
    for (const f of devFields) parts.push(u8(f.num), u8(f.size), u8(f.devIndex));
  }
  return Buffer.concat(parts);
}

/** 数据消息：payload 为按定义顺序拼好的字段字节 */
function dataMsg(local, payload) {
  return Buffer.concat([u8(local), payload]);
}

/** 组装完整 FIT 文件（文件头 + 消息序列 + CRC） */
export function encodeFit(messages) {
  const data = Buffer.concat(messages);
  const head = Buffer.concat([
    u8(14), // header 长度
    u8(0x10), // 协议版本 1.0
    u16(2132), // profile 版本
    u32(data.length),
    Buffer.from(".FIT"),
  ]);
  const header = Buffer.concat([head, u16(crc16(head))]);
  return Buffer.concat([header, data, u16(crc16(Buffer.concat([header, data])))]);
}

// FIT 枚举值（FIT SDK 标准 profile）
export const ENUM = {
  sport: { generic: 0, running: 1, cycling: 2, swimming: 5 },
  fileType: { activity: 4 },
};

const fitTs = (ms) => Math.round(ms / 1000) - FIT_EPOCH;

// ---------------- 各消息类型的字段定义 ----------------

const LOCAL = { fileId: 0, sport: 1, record: 2, lap: 3, session: 4, length: 5, devId: 6, fieldDesc: 7 };

function fileIdMsgs(startMs) {
  const def = defMsg(LOCAL.fileId, 0, [
    { num: 0, size: 1, base: BASE.enum }, // type
    { num: 1, size: 2, base: BASE.uint16 }, // manufacturer
    { num: 4, size: 4, base: BASE.uint32 }, // time_created
  ]);
  const dat = dataMsg(
    LOCAL.fileId,
    Buffer.concat([u8(ENUM.fileType.activity), u16(1), u32(fitTs(startMs))]),
  );
  return [def, dat];
}

function sportMsgs(sportEnum) {
  const def = defMsg(LOCAL.sport, 12, [{ num: 0, size: 1, base: BASE.enum }]);
  return [def, dataMsg(LOCAL.sport, u8(sportEnum))];
}

/**
 * record 消息序列。
 * records: [{ t (Date ms), power, heart_rate, cadence, altitude, speed (m/s), distance (m), temperature (℃) }]
 * null 字段写 FIT 无效值；devField = { num, value } 时每条记录附带 1 字节开发者字段。
 */
function recordMsgs(records, devField = null) {
  const fields = [
    { num: 253, size: 4, base: BASE.uint32 }, // timestamp
    { num: 7, size: 2, base: BASE.uint16 }, // power
    { num: 3, size: 1, base: BASE.uint8 }, // heart_rate
    { num: 4, size: 1, base: BASE.uint8 }, // cadence
    { num: 2, size: 2, base: BASE.uint16 }, // altitude (scale 5, offset -500)
    { num: 6, size: 2, base: BASE.uint16 }, // speed (scale 1000, m/s)
    { num: 5, size: 4, base: BASE.uint32 }, // distance (scale 100, m)
    { num: 13, size: 1, base: BASE.sint8 }, // temperature (℃)
  ];
  const devs = devField ? [{ num: devField.num, size: 1, devIndex: 0 }] : null;
  const msgs = [defMsg(LOCAL.record, 20, fields, devs)];
  for (const r of records) {
    const parts = [
      r.t != null ? u32(fitTs(r.t)) : u32(0xffffffff),
      r.power != null ? u16(r.power) : u16(0xffff),
      r.heart_rate != null ? u8(r.heart_rate) : u8(0xff),
      r.cadence != null ? u8(r.cadence) : u8(0xff),
      r.altitude != null ? u16((r.altitude + 500) * 5) : u16(0xffff),
      r.speed != null ? u16(r.speed * 1000) : u16(0xffff),
      r.distance != null ? u32(r.distance * 100) : u32(0xffffffff),
      r.temperature != null ? u8(r.temperature & 0xff) : u8(0x7f),
    ];
    if (devField) parts.push(u8(devField.value));
    msgs.push(dataMsg(LOCAL.record, Buffer.concat(parts)));
  }
  return msgs;
}

function lapMsg({ startMs, elapsedSec, distanceM, avgPower, avgHr, avgSpeedMS }) {
  const def = defMsg(LOCAL.lap, 19, [
    { num: 253, size: 4, base: BASE.uint32 }, // timestamp
    { num: 7, size: 4, base: BASE.uint32 }, // total_elapsed_time (scale 1000)
    { num: 9, size: 4, base: BASE.uint32 }, // total_distance (scale 100)
    { num: 19, size: 2, base: BASE.uint16 }, // avg_power
    { num: 15, size: 1, base: BASE.uint8 }, // avg_heart_rate
    { num: 13, size: 2, base: BASE.uint16 }, // avg_speed (scale 1000, m/s)
  ]);
  const dat = dataMsg(
    LOCAL.lap,
    Buffer.concat([
      u32(fitTs(startMs)),
      u32(elapsedSec * 1000),
      u32(distanceM * 100),
      avgPower != null ? u16(avgPower) : u16(0xffff),
      avgHr != null ? u8(avgHr) : u8(0xff),
      avgSpeedMS != null ? u16(avgSpeedMS * 1000) : u16(0xffff),
    ]),
  );
  return [def, dat];
}

function sessionMsg({ startMs, sport, elapsedSec, distanceM, avgHr, poolLengthM, totalCalories, avgSpeedMS }) {
  const def = defMsg(LOCAL.session, 18, [
    { num: 253, size: 4, base: BASE.uint32 }, // timestamp
    { num: 5, size: 1, base: BASE.enum }, // sport
    { num: 7, size: 4, base: BASE.uint32 }, // total_elapsed_time (scale 1000)
    { num: 9, size: 4, base: BASE.uint32 }, // total_distance (scale 100)
    { num: 16, size: 1, base: BASE.uint8 }, // avg_heart_rate
    { num: 44, size: 2, base: BASE.uint16 }, // pool_length (scale 100, m)
    { num: 11, size: 2, base: BASE.uint16 }, // total_calories (kcal)
    { num: 14, size: 2, base: BASE.uint16 }, // avg_speed (scale 1000, m/s)
  ]);
  const dat = dataMsg(
    LOCAL.session,
    Buffer.concat([
      u32(fitTs(startMs)),
      u8(sport),
      u32(elapsedSec * 1000),
      distanceM != null ? u32(distanceM * 100) : u32(0xffffffff),
      avgHr != null ? u8(avgHr) : u8(0xff),
      poolLengthM != null ? u16(poolLengthM * 100) : u16(0xffff),
      totalCalories != null ? u16(totalCalories) : u16(0xffff),
      avgSpeedMS != null ? u16(avgSpeedMS * 1000) : u16(0xffff),
    ]),
  );
  return [def, dat];
}

/** 游泳 length 消息（逐趟：时长/划水次数/平均速度） */
function lengthMsgs(lengths) {
  // lengths: [{ startMs, elapsedSec, strokes, avgSpeedMS }]
  const def = defMsg(LOCAL.length, 101, [
    { num: 254, size: 2, base: BASE.uint16 }, // message_index
    { num: 253, size: 4, base: BASE.uint32 }, // timestamp
    { num: 2, size: 4, base: BASE.uint32 }, // start_time
    { num: 3, size: 4, base: BASE.uint32 }, // total_elapsed_time (scale 1000)
    { num: 5, size: 2, base: BASE.uint16 }, // total_strokes
    { num: 6, size: 2, base: BASE.uint16 }, // avg_speed (scale 1000, m/s)
    { num: 12, size: 1, base: BASE.enum }, // length_type (1 = active)
  ]);
  const msgs = [def];
  lengths.forEach((l, i) => {
    msgs.push(
      dataMsg(
        LOCAL.length,
        Buffer.concat([
          u16(i),
          u32(fitTs(l.startMs + l.elapsedSec * 1000)),
          u32(fitTs(l.startMs)),
          u32(l.elapsedSec * 1000),
          u16(l.strokes),
          u16(l.avgSpeedMS * 1000),
          u8(1),
        ]),
      ),
    );
  });
  return msgs;
}

/** 开发者字段声明（developer_data_id + field_description），使 record 里的附加字节能被命名解析 */
function devFieldDeclareMsgs(fieldName) {
  const appId = defMsg(LOCAL.devId, 207, [
    { num: 1, size: 16, base: BASE.byte }, // application_id
    { num: 3, size: 1, base: BASE.uint8 }, // developer_data_index
  ]);
  const appData = dataMsg(LOCAL.devId, Buffer.concat([Buffer.alloc(16, 1), u8(0)]));
  const nameBuf = Buffer.alloc(16);
  nameBuf.write(fieldName);
  const descDef = defMsg(LOCAL.fieldDesc, 206, [
    { num: 0, size: 1, base: BASE.uint8 }, // developer_data_index
    { num: 1, size: 1, base: BASE.uint8 }, // field_definition_number
    { num: 2, size: 1, base: BASE.uint8 }, // fit_base_type_id (2 = uint8)
    { num: 3, size: 16, base: BASE.string }, // field_name
  ]);
  const descData = dataMsg(
    LOCAL.fieldDesc,
    Buffer.concat([u8(0), u8(0), u8(2), nameBuf]),
  );
  return [appId, appData, descDef, descData];
}

// ---------------- 场景生成 ----------------

/**
 * 逐秒记录数组生成。
 * dropSpans: [[起始秒偏移, 时长]] 这些秒完全不产生记录（模拟损坏/掉包）；
 * badTimestampOffsets: 这些秒的记录时间戳无效（模拟解析损坏被丢弃）。
 */
function buildRecords({
  startMs,
  durationSec,
  power = null,
  heartRate = null, // 数值或 (sec) => bpm
  cadence = null, // 数值或 (sec) => rpm
  altitude = null,
  speedMS = null,
  temperature = null,
  powerGap = null, // [起始秒偏移, 时长]，区间内 power 置 null（设备掉秒）
  dropSpans = [],
  badTimestampOffsets = [],
}) {
  const inSpans = (i, spans) => spans.some(([s, l]) => i >= s && i < s + l);
  const records = [];
  for (let i = 0; i < durationSec; i++) {
    if (inSpans(i, dropSpans)) continue;
    records.push({
      t: badTimestampOffsets.includes(i) ? null : startMs + i * 1000,
      power:
        power != null && !(powerGap && inSpans(i, [powerGap])) ? power : null,
      heart_rate:
        heartRate != null
          ? typeof heartRate === "function"
            ? heartRate(i)
            : heartRate
          : null,
      cadence:
        cadence != null
          ? typeof cadence === "function"
            ? cadence(i)
            : cadence
          : null,
      altitude,
      speed: speedMS,
      distance: speedMS != null ? Math.round(i * speedMS) : null,
      temperature,
    });
  }
  return records;
}

/** 合成骑行 FIT（30 分钟模拟骑行，可注入功率缺失/记录缺失） */
export function buildRideFit(opts = {}) {
  const startMs = opts.startMs ?? Date.UTC(2024, 0, 15, 10, 0, 0);
  const durationSec = opts.durationSec ?? 1800;
  const power = opts.power ?? 200;
  const speedMS = opts.speedMS ?? 10;
  const devField = opts.devField ?? null; // { name, value }
  const records = buildRecords({
    startMs,
    durationSec,
    power,
    heartRate: opts.heartRate ?? 140,
    cadence: opts.cadence ?? 90,
    altitude: 100,
    speedMS,
    temperature: opts.temperature ?? 25,
    powerGap: opts.powerGap,
    dropSpans: opts.dropSpans,
    badTimestampOffsets: opts.badTimestampOffsets,
  });
  const msgs = [
    ...fileIdMsgs(startMs),
    ...sportMsgs(ENUM.sport.cycling),
    ...(devField ? devFieldDeclareMsgs(devField.name) : []),
    ...recordMsgs(records, devField ? { num: 0, value: devField.value } : null),
    ...lapMsg({
      startMs,
      elapsedSec: durationSec,
      distanceM: durationSec * speedMS,
      avgPower: power,
      avgHr: 140,
      avgSpeedMS: speedMS,
    }),
    ...sessionMsg({
      startMs,
      sport: ENUM.sport.cycling,
      elapsedSec: durationSec,
      distanceM: durationSec * speedMS,
      avgHr: 140,
      totalCalories: opts.totalCalories ?? 360,
      avgSpeedMS: speedMS,
    }),
  ];
  return encodeFit(msgs);
}

/** 合成跑步 FIT（无功率计：配速/步频为核心指标） */
export function buildRunFit(opts = {}) {
  const startMs = opts.startMs ?? Date.UTC(2024, 0, 16, 7, 0, 0);
  const durationSec = opts.durationSec ?? 1200;
  const speedMS = opts.speedMS ?? 10 / 3; // 12 km/h = 5 min/km
  const records = buildRecords({
    startMs,
    durationSec,
    heartRate: opts.heartRate ?? ((i) => (i < durationSec / 2 ? 140 : 150)),
    cadence: 170,
    altitude: 50,
    speedMS,
  });
  const msgs = [
    ...fileIdMsgs(startMs),
    ...sportMsgs(ENUM.sport.running),
    ...recordMsgs(records),
    ...lapMsg({
      startMs,
      elapsedSec: durationSec,
      distanceM: durationSec * speedMS,
      avgPower: null,
      avgHr: 145,
      avgSpeedMS: speedMS,
    }),
    ...sessionMsg({
      startMs,
      sport: ENUM.sport.running,
      elapsedSec: durationSec,
      distanceM: durationSec * speedMS,
      avgHr: 145,
    }),
  ];
  return encodeFit(msgs);
}

/** 合成泳池游泳 FIT（length 消息逐趟 + 仅心率记录） */
export function buildSwimFit(opts = {}) {
  const startMs = opts.startMs ?? Date.UTC(2024, 0, 17, 19, 0, 0);
  const lengths = opts.lengths ?? 20;
  const poolLengthM = opts.poolLengthM ?? 25;
  const lengthSec = opts.lengthSec ?? 30;
  const strokes = opts.strokes ?? 18;
  const durationSec = lengths * lengthSec;
  const records = buildRecords({ startMs, durationSec, heartRate: 130 });
  const lengthArr = Array.from({ length: lengths }, (_, i) => ({
    startMs: startMs + i * lengthSec * 1000,
    elapsedSec: lengthSec,
    strokes,
    avgSpeedMS: poolLengthM / lengthSec,
  }));
  const msgs = [
    ...fileIdMsgs(startMs),
    ...sportMsgs(ENUM.sport.swimming),
    ...recordMsgs(records),
    ...lengthMsgs(lengthArr),
    ...sessionMsg({
      startMs,
      sport: ENUM.sport.swimming,
      elapsedSec: durationSec,
      distanceM: lengths * poolLengthM,
      avgHr: 130,
      poolLengthM,
    }),
  ];
  return encodeFit(msgs);
}

// ---------------- CLI：直接运行时生成样例文件 ----------------

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const outDir = process.argv[2] || path.resolve("test", "fixtures");
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    "synthetic_ride.fit": buildRideFit({ powerGap: [600, 60] }),
    "synthetic_run.fit": buildRunFit(),
    "synthetic_swim.fit": buildSwimFit(),
  };
  for (const [name, buf] of Object.entries(files)) {
    fs.writeFileSync(path.join(outDir, name), buf);
    console.log("已生成:", path.join(outDir, name));
  }
}
