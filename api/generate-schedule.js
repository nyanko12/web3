// Vercelサーバーレス関数: Claude Haiku で学習スケジュールを生成する
//
// 重要: APIキーはこのコードに直書きせず、Vercelの環境変数 ANTHROPIC_API_KEY から読む。
//       （ブラウザにキーを露出させないため、生成処理は必ずこのサーバー側を経由する）
//
// 入力 (POST body): { subjects, blockedDays, blockedSlots }
// 出力 (JSON):      { sessions: [{date, subjectId, startMin, endMin}], advice: [{type, text}] }

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
// モデルIDは環境変数 ANTHROPIC_MODEL で上書き可能（未設定ならHaikuを使う）。
// ※ モデルは秘密ではないただの文字列。認証は ANTHROPIC_API_KEY 1つで全モデル共通。
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

// Haikuに返させるJSONの形を固定する（パース失敗を防ぐ）
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date:      { type: "string" },  // "YYYY-MM-DD"
          subjectId: { type: "integer" }, // st.subjects[].id に対応
          startMin:  { type: "integer" }, // 0時からの分 (0-1440)
          endMin:    { type: "integer" }, // 0時からの分 (0-1440)
        },
        required: ["date", "subjectId", "startMin", "endMin"],
        additionalProperties: false,
      },
    },
    advice: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" }, // "info" | "warn"
          text: { type: "string" },
        },
        required: ["type", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["sessions", "advice"],
  additionalProperties: false,
};

const DAYS_JP = ["日", "月", "火", "水", "木", "金", "土"];

// 分 → "HH:MM" 表記（プロンプトを人間が読みやすくするため）
function minToTime(m) {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// 指定曜日(dow)のブロック時間帯を1日(0-1440分)から引いて、空き時間帯を計算する
function freeWindowsForDay(blockedSlots, dow) {
  let slots = [{ start: 0, end: 1440 }];
  for (const b of blockedSlots || []) {
    if (b.day !== dow) continue; // その曜日のブロックのみ
    const res = [];
    for (const s of slots) {
      if (b.end <= s.start || b.start >= s.end) { res.push(s); continue; }
      if (b.start > s.start) res.push({ start: s.start, end: b.start });
      if (b.end < s.end) res.push({ start: b.end, end: s.end });
    }
    slots = res;
  }
  return slots.filter((s) => s.end - s.start >= 30);
}

// 科目群から全体の期間(最小start〜最大end)を求める
function rangeBounds(subjects) {
  let start = subjects[0].start, end = subjects[0].end;
  for (const s of subjects) {
    if (s.start < start) start = s.start;
    if (s.end > end) end = s.end;
  }
  return { start, end };
}

// "YYYY-MM-DD" の期間を1日ずつ列挙（UTC基準で曜日も返す）
function eachDate(startStr, endStr) {
  const [ys, ms, ds] = startStr.split("-").map(Number);
  const [ye, me, de] = endStr.split("-").map(Number);
  let cur = Date.UTC(ys, ms - 1, ds);
  const end = Date.UTC(ye, me - 1, de);
  const out = [];
  while (cur <= end) {
    const d = new Date(cur);
    out.push({ date: d.toISOString().slice(0, 10), dow: d.getUTCDay() });
    cur += 86400000;
  }
  return out;
}

// 入力から、Haikuに渡すプロンプト本文を組み立てる
function buildPrompt({ subjects, blockedDays, blockedSlots }) {
  const subjectLines = subjects
    .map((s) => {
      const sessLbl = s.session >= 60 ? `${s.session / 60}時間` : `${s.session}分`;
      const prioLbl = { 3: "高", 2: "中", 1: "低" }[s.priority] || "中";
      return [
        `- ID=${s.id} 「${s.name}」`,
        `期間 ${s.start}〜${s.end}`,
        `1日の目標 ${s.daily}分`,
        `1セッション ${sessLbl}`,
        `優先度 ${prioLbl}`,
        s.goal ? `目標「${s.goal}」` : null,
      ]
        .filter(Boolean)
        .join(" / ");
    })
    .join("\n");

  // 曜日ごとの許可時間帯（終日ブロック曜日 or 空きなしは null=終日不可）
  const dayWindows = {};
  for (let d = 0; d < 7; d++) {
    if ((blockedDays || []).includes(d)) { dayWindows[d] = null; continue; }
    const w = freeWindowsForDay(blockedSlots, d);
    dayWindows[d] = w.length ? w : null;
  }
  const fmtWin = (w) =>
    w
      ? w.map((s) => `${s.start}-${s.end}(${minToTime(s.start)}-${minToTime(s.end)})`).join(", ")
      : "終日学習不可";

  // 期間内の各日付に、その日の許可時間帯を割り当てる（Haikuに曜日計算をさせない）
  const { start: rs, end: re } = rangeBounds(subjects);
  const dates = eachDate(rs, re);
  let scheduleSection;
  if (dates.length <= 120) {
    scheduleSection = dates
      .map(({ date, dow }) => `- ${date}(${DAYS_JP[dow]}): ${fmtWin(dayWindows[dow])}`)
      .join("\n");
  } else {
    // 長期間は曜日別の凡例のみ（各日付の曜日を判定して該当窓を使う）
    scheduleSection =
      "（期間が長いため曜日別に記載。各日付の曜日を判定し、その曜日の許可窓を使うこと）\n" +
      [0, 1, 2, 3, 4, 5, 6]
        .map((d) => `- ${DAYS_JP[d]}曜: ${fmtWin(dayWindows[d])}`)
        .join("\n");
  }

  return `あなたは学習スケジュールのプランナーです。以下の条件に従い、各科目の学習セッションを期間全体にわたって配置してください。

# 科目
${subjectLines}

# 各日の学習に使える時間帯（この範囲内だけにセッションを置くこと。数値は0時からの分）
${scheduleSection}

# 配置ルール（厳守）
- 各セッションの startMin〜endMin は、その「日付」の許可時間帯のいずれか1つに完全に収めること。許可窓をまたいだり、外れたり、はみ出したりしてはならない。
- 「終日学習不可」の日付にはセッションを一切置かないこと。
- 各科目はその科目の期間（start〜end）内の日付にのみ置くこと。
- 各セッションは最低30分。可能な限り「1セッション」の長さに合わせる。
- 各科目の「1日の目標」分数をできるだけ満たす。1日に複数セッションを置いてよいが、すべて許可窓の範囲内に収めること。
- 優先度が高い科目、締め切り（期間終了日）が近い科目を優先する。
- 同じ日のセッション同士は時間を重ねないこと。連続させる場合も最低1分は空ける（推奨は15分の休憩）。
- date は YYYY-MM-DD。subjectId は上記の科目IDを使う。startMin / endMin は 0〜1440 の整数。

# アドバイス
- 達成が難しい科目があれば advice に type="warn" で日本語で簡潔に記載する。
- 特に問題なければ advice に type="info" で短い励ましを1件入れてもよい。

期間全体の全セッションを漏れなく出力してください。`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POSTのみ対応しています" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY が未設定です" });
    return;
  }

  // body のパース（Vercelは通常自動でJSON化するが念のため両対応）
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.status(400).json({ error: "リクエストボディが不正です" });
      return;
    }
  }
  const { subjects, blockedDays, blockedSlots } = body || {};
  if (!Array.isArray(subjects) || subjects.length === 0) {
    res.status(400).json({ error: "subjects がありません" });
    return;
  }

  try {
    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        messages: [
          {
            role: "user",
            content: buildPrompt({ subjects, blockedDays, blockedSlots }),
          },
        ],
        // 出力を固定スキーマのJSONに制約する
        output_config: {
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      res
        .status(502)
        .json({ error: "Anthropic APIエラー", detail: errText.slice(0, 500) });
      return;
    }

    const data = await anthropicRes.json();
    // output_config.format 指定時、最初のテキストブロックが有効なJSON文字列
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      res.status(502).json({ error: "応答にテキストがありません" });
      return;
    }
    const parsed = JSON.parse(textBlock.text);
    res.status(200).json({
      sessions: parsed.sessions || [],
      advice: parsed.advice || [],
    });
  } catch (e) {
    res.status(500).json({ error: "生成に失敗しました", detail: String(e) });
  }
}
