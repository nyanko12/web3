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

  const blockedDayLines =
    blockedDays && blockedDays.length
      ? blockedDays.map((i) => DAYS_JP[i] + "曜").join("、")
      : "なし";

  const blockedSlotLines =
    blockedSlots && blockedSlots.length
      ? blockedSlots
          .map(
            (b) =>
              `- ${b.label || "不可"}: 毎日 ${minToTime(b.start)}〜${minToTime(b.end)}`,
          )
          .join("\n")
      : "なし";

  return `あなたは学習スケジュールのプランナーです。以下の条件に従い、各科目の学習セッションを期間全体にわたって配置してください。

# 科目
${subjectLines}

# 学習しない曜日（ブロック曜日）
${blockedDayLines}

# 毎日使えない時間帯（ブロック時間帯, 0時起点の時刻）
${blockedSlotLines}

# 配置ルール
- 各セッションはブロック時間帯・ブロック曜日を避けて配置する。
- 各セッションは最低30分。可能な限り「1セッション」の長さに合わせる。
- 各科目の「1日の目標」分数を、その科目の期間内の各有効日でできるだけ満たす。
- 優先度が高い科目、締め切り（期間終了日）が近い科目を優先する。
- セッション同士は重ならないようにし、連続する場合は15分程度の休憩を空ける。
- date は科目の期間内（YYYY-MM-DD）。subjectId は上記の科目IDを使う。
- startMin / endMin は 0〜1440 の整数（0時からの分）。

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
