// Ask KAD: the admin asks a question in plain language, a Claude model answers it by calling the read-only
// data tools (tools.js) and the server hands back the answer with real names put back (anonymize.js).
// The model never touches the database itself and never sees a name: facts come from the tools, the model
// only picks which questions to ask the data, adds them up and explains.
//
// Cost control: every call is logged (ask_kad_log) with its token counts and an estimated cost; once the
// month's total reaches the cap the admin sets in App configuration, new questions are refused.
import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/pool.js";
import { yerevanToday } from "../utils/yerevanDate.js";
import { loadNameBook, maskText, unmaskText } from "./anonymize.js";
import { getAskKadSettings, monthSpendUsd } from "./settings.js";
import { TOOLS, runTool } from "./tools.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY = 12;

// USD per million tokens (Anthropic price list); an unknown model is priced like the default so the cap errs on the safe side.
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export const estimateCostUsd = (model, usage) => {
  const p = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  const cached = usage.cache_read_input_tokens ?? 0;
  return ((usage.input_tokens ?? 0) * p.input + cached * p.cacheRead + (usage.output_tokens ?? 0) * p.output) / 1e6;
};

const SYSTEM = `You are "Ask KAD", the business analyst of KAD Motors, an Armenian distributor of Castrol, Lotos, Royal and Orlen lubricants. You answer questions from the owner (the company's admin) about the company's own sales, debt, customers, visits and plan.

How you work
- Every number comes from the tools. Never guess or estimate a figure that a tool can give; if the tools cannot answer, say exactly what is missing instead of inventing it.
- The ERP/Excel order lines are the trusted truth for sales and debt. Orders made in the app but not yet in the ERP are not included in sales.
- Customers and staff appear as codes (CUST-123 for a customer, REP-5 for a sales rep). Write each code exactly as given, never invent a code or guess whose it is; the system replaces codes with real names before the owner reads the answer.
- Call several tools in parallel when the question needs them, and keep the number of calls small.
- Separate what the data shows from your own interpretation, and say when a conclusion is only a hypothesis.

How you answer
- Answer in the language of the question (Armenian by default for Armenian questions). Use plain, everyday, warm words; in Armenian call management "ղեկավարություն".
- Short and scannable: a one-line headline answer, then bullet lines in the form "• label: value". No tables, no long paragraphs.
- Money is AMD in whole numbers with thousands separators (5,700 դր). Volume is in liters (4 L).
- When there is a clear next step (call a customer, check a rep, collect a debt), finish with one line "Recommended action: ..." that names who should do what.`;

class AskError extends Error {
  constructor(code, status, message) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

export const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let sharedClient = null;
const defaultClient = () => (sharedClient ??= new Anthropic());

const textOf = (content) => content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

// history: [{ role: "user" | "assistant", text }] -- earlier turns of this conversation, as the admin saw them.
export async function askKad({ question, history = [], userId, client = null, db = pool, now = new Date() }) {
  if (!client && !isConfigured()) throw new AskError("not_configured", 503, "ANTHROPIC_API_KEY is not set");
  const settings = await getAskKadSettings(db);
  if (!settings.enabled) throw new AskError("disabled", 403, "Ask KAD is switched off");
  const today = yerevanToday(now);
  const spent = await monthSpendUsd(db, today);
  if (spent >= settings.capUsd) throw new AskError("cap_reached", 429, `monthly cap of ${settings.capUsd} USD reached`);

  const model = process.env.ASK_KAD_MODEL || DEFAULT_MODEL;
  const book = await loadNameBook(db);
  const maskedQuestion = maskText(question, book);
  let masked = maskedQuestion.count;
  const messages = history.slice(-MAX_HISTORY).map((h) => {
    const m = maskText(h.text, book);
    masked += m.count;
    return { role: h.role, content: m.text };
  });
  messages.push({ role: "user", content: `Today (Yerevan): ${today}.\n\n${maskedQuestion.text}` });

  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const toolsUsed = [];
  let error = null;
  let answer = "";
  try {
    const api = client ?? defaultClient();
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await api.beta.messages.create({
        model,
        max_tokens: 16000,
        system: SYSTEM,
        tools: TOOLS,
        messages,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      usage.input_tokens += response.usage?.input_tokens ?? 0;
      usage.output_tokens += response.usage?.output_tokens ?? 0;
      usage.cache_read_input_tokens += response.usage?.cache_read_input_tokens ?? 0;

      if (response.stop_reason === "refusal") throw new AskError("refused", 422, "the model declined this question");
      if (response.stop_reason !== "tool_use") {
        answer = textOf(response.content);
        if (response.stop_reason === "max_tokens") answer += "\n\n(…the answer was cut short; ask for a narrower question.)";
        break;
      }
      // Thinking blocks must go back to the model unchanged, so the whole content is appended.
      messages.push({ role: "assistant", content: response.content });
      const calls = response.content.filter((b) => b.type === "tool_use");
      const results = await Promise.all(
        calls.map(async (call) => {
          toolsUsed.push(call.name);
          const out = await runTool(call.name, call.input, { db, today });
          return { type: "tool_result", tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) };
        })
      );
      // All results of one assistant turn go back in a single user message.
      messages.push({ role: "user", content: results });
      if (round === MAX_TOOL_ROUNDS - 1) throw new AskError("too_many_steps", 422, "the question needed too many data lookups");
    }
    if (!answer) throw new AskError("empty", 502, "the model returned no text");
  } catch (err) {
    error = err instanceof AskError ? err.code : `ai_error: ${String(err.message ?? err).slice(0, 300)}`;
    throw err instanceof AskError ? err : Object.assign(new AskError("ai_error", 502, String(err.message ?? err)), { cause: err });
  } finally {
    const cost = estimateCostUsd(model, usage);
    await db
      .query(
        `INSERT INTO ask_kad_log (user_id, question_masked, masked_names, tools, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [userId ?? null, maskedQuestion.text.slice(0, 2000), masked, toolsUsed, model, usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, cost, error]
      )
      .catch((e) => console.error("ask_kad_log insert failed:", e.message));
  }
  return {
    answer: unmaskText(answer, book),
    maskedNames: masked,
    tools: [...new Set(toolsUsed)],
    costUsd: Math.round(estimateCostUsd(model, usage) * 10000) / 10000,
    model,
  };
}

// "Test connection" for the admin: one tiny question ("say OK"), so a missing / rejected key, an empty credit balance or a wrong model name shows up
// in plain words before anybody asks a real question. Costs a fraction of a cent and is not logged against the monthly cap.
const classifyAiError = (err) => {
  const status = err?.status;
  const text = String(err?.message ?? err ?? "");
  if (status === 401 || status === 403) return "key_rejected";
  if (/credit balance|billing|payment/i.test(text)) return "no_credit";
  if (status === 429) return "rate_limit";
  if (status === 404 || /model/i.test(text) && /not.?found|does not exist|invalid/i.test(text)) return "model_not_found";
  if (err?.name === "APIConnectionTimeoutError" || err?.name === "APIConnectionError" || err?.code === "ETIMEDOUT") return "unreachable";
  return "ai_error";
};

export async function pingAi({ client = null } = {}) {
  const model = process.env.ASK_KAD_MODEL || DEFAULT_MODEL;
  if (!client && !isConfigured()) return { ok: false, code: "not_configured", model };
  const started = Date.now();
  try {
    const api = client ?? new Anthropic({ timeout: 20000, maxRetries: 0 });
    const response = await api.messages.create({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }] });
    return { ok: true, model, ms: Date.now() - started, reply: textOf(response.content).slice(0, 40) };
  } catch (err) {
    const code = classifyAiError(err);
    return { ok: false, code, model, ms: Date.now() - started, ...(code === "ai_error" ? { detail: String(err?.message ?? err).slice(0, 200) } : {}) };
  }
}

export { AskError };
